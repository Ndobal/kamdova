import type { Context } from 'hono';
import { Hono } from 'hono';
import type { App, AuthContext } from '../types';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound, ok, paginated, readPagination, routeParam } from '../lib/http';
import { newId } from '../lib/crypto';
import { consumeGeneration, refundGeneration, requireGenerationAllowance } from '../lib/entitlements';
import { generateLessonNote, generateStudentNote, type LessonRow } from '../lib/generation';
import { hasPermission, requirePermission } from '../lib/rbac';
import { ensureTeacher } from './teachers';
import { nowIso } from '../lib/time';
import { readJson, Validator } from '../lib/validate';

export const lessonRoutes = new Hono<App>();

/**
 * Loads a lesson and proves the caller may touch it.
 *
 * Ownership is the teacher's own user id from the verified session; the lesson
 * id in the URL is never treated as authorisation. An admin holding
 * content.read may read any lesson but is not granted write access here --
 * moderation is a separate, audited action, not an implicit side effect of
 * being able to look.
 */
async function loadLesson(
  c: Context<App>,
  lessonId: string,
  access: 'read' | 'write',
): Promise<LessonRow> {
  const auth: AuthContext = c.get('auth');

  const lesson = await c.env.DB
    .prepare(`SELECT * FROM lessons WHERE id = ? AND deleted_at IS NULL`)
    .bind(lessonId)
    .first<LessonRow>();
  if (!lesson) throw notFound('Lesson');

  if (lesson.teacher_id === auth.userId) return lesson;

  if (access === 'read' && hasPermission(auth, 'content.read')) return lesson;
  if (access === 'write' && hasPermission(auth, 'content.moderate')) return lesson;

  // Same response as a missing lesson would give, so the endpoint cannot be
  // used to discover which lesson ids exist.
  throw forbidden('This lesson does not belong to you.');
}

async function teacherName(db: D1Database, userId: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT COALESCE(p.display_name, p.first_name || ' ' || p.last_name, u.email) AS name
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`,
    )
    .bind(userId)
    .first<{ name: string }>();
  return row?.name ?? '';
}

const LESSON_SELECT = `
  SELECT l.id, l.topic, l.subtopic, l.theme, l.subject_name AS subjectName,
         l.class_name AS className, l.week, l.term, l.lesson_date AS lessonDate,
         l.duration_minutes AS durationMinutes, l.status, l.last_error AS lastError,
         l.created_at AS createdAt, l.updated_at AS updatedAt,
         tpl.code AS templateCode, tpl.name AS templateName,
         (SELECT COUNT(*) FROM lesson_notes n WHERE n.lesson_id = l.id) AS teacherNoteCount,
         (SELECT COUNT(*) FROM student_notes s WHERE s.lesson_id = l.id) AS studentNoteCount
    FROM lessons l JOIN lesson_templates tpl ON tpl.id = l.template_id`;

// ---------------------------------------------------------------- listing ----
lessonRoutes.get('/', requirePermission('teacher.self.lessons.read', 'content.read'), async (c) => {
  const auth = c.get('auth');
  const { page, perPage, offset } = readPagination(c);

  const filters = ['l.deleted_at IS NULL'];
  const params: unknown[] = [];

  // A teacher sees only their own. Reviewers with content.read may pass
  // ?teacherId= to scope; without it they see everything they are allowed to.
  if (!hasPermission(auth, 'content.read')) {
    filters.push('l.teacher_id = ?');
    params.push(auth.userId);
  } else {
    const teacherId = c.req.query('teacherId');
    if (teacherId) { filters.push('l.teacher_id = ?'); params.push(teacherId); }
  }

  const status = c.req.query('status');
  const search = c.req.query('search')?.trim();
  if (status) { filters.push('l.status = ?'); params.push(status); }
  if (search) {
    filters.push('(l.topic LIKE ? OR l.subtopic LIKE ? OR l.subject_name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const where = `WHERE ${filters.join(' AND ')}`;
  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM lessons l ${where}`)
    .bind(...params).first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `${LESSON_SELECT} ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...params, perPage, offset).all();

  return paginated(c, results, { page, perPage, total: countRow?.total ?? 0 });
});

lessonRoutes.get('/:id', requirePermission('teacher.self.lessons.read', 'content.read'), async (c) => {
  const id = routeParam(c, 'id');
  await loadLesson(c, id, 'read');

  const [lesson, teacherNotes, studentNotes] = await Promise.all([
    c.env.DB.prepare(`${LESSON_SELECT} WHERE l.id = ?`).bind(id).first(),
    c.env.DB.prepare(
      `SELECT id, version, status, origin, published_at AS publishedAt, updated_at AS updatedAt
         FROM lesson_notes WHERE lesson_id = ? ORDER BY version DESC`,
    ).bind(id).all(),
    c.env.DB.prepare(
      `SELECT id, version, status, origin, published_at AS publishedAt, updated_at AS updatedAt
         FROM student_notes WHERE lesson_id = ? ORDER BY version DESC`,
    ).bind(id).all(),
  ]);

  return ok(c, { ...lesson, teacherNotes: teacherNotes.results, studentNotes: studentNotes.results });
});

// --------------------------------------------------------------- creation ----
lessonRoutes.post('/', requirePermission('teacher.self.lessons.write'), async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);

  const topic = v.string('topic', { required: true, max: 200 });
  const subtopic = v.string('subtopic', { max: 200 });
  const theme = v.string('theme', { max: 200 });
  const subjectCode = v.string('subjectCode', { max: 40 });
  const subjectName = v.string('subjectName', { max: 120 });
  const classCode = v.string('classCode', { max: 40 });
  const className = v.string('className', { max: 120 });
  const schoolName = v.string('schoolName', { max: 200 });
  const week = v.integer('week', { min: 1, max: 20 });
  const term = v.enum('term', ['FIRST', 'SECOND', 'THIRD'] as const);
  const lessonDate = v.date('lessonDate');
  const durationMinutes = v.integer('durationMinutes', { min: 5, max: 240 });
  const classSize = v.integer('classSize', { min: 0, max: 500 });
  const averageAge = v.integer('averageAge', { min: 2, max: 60 });
  const sexMix = v.enum('sexMix', ['MIXED', 'MALE', 'FEMALE'] as const);
  const curriculum = v.string('curriculum', { max: 300 });
  const extraInstructions = v.string('extraInstructions', { max: 2000 });
  const templateCode = v.string('templateCode', { max: 40 });
  const objectives = v.array<string>('objectives');
  v.assert();

  // The teacher row is an internal detail; someone holding the TEACHER role
  // should not be blocked from their first lesson because they have not opened
  // the profile screen yet.
  await ensureTeacher(c.env.DB, auth.userId);
  const teacher = await c.env.DB
    .prepare(`SELECT user_id, school_name, default_template_id, status FROM teachers WHERE user_id = ?`)
    .bind(auth.userId)
    .first<{ user_id: string; school_name: string | null; default_template_id: string | null; status: string }>();
  if (!teacher) throw badRequest('Could not set up your teacher profile.');
  if (teacher.status === 'SUSPENDED') throw forbidden('Your teacher account is suspended.');

  // Resolve the reference rows when codes are given, but keep the free-text
  // names as the source of truth for what gets printed on the note.
  const subject = subjectCode
    ? await c.env.DB.prepare(`SELECT id, name FROM subjects WHERE code = ?`).bind(subjectCode)
        .first<{ id: string; name: string }>()
    : null;
  const classLevel = classCode
    ? await c.env.DB.prepare(`SELECT id, name FROM class_levels WHERE code = ?`).bind(classCode)
        .first<{ id: string; name: string }>()
    : null;

  const resolvedSubject = subjectName ?? subject?.name;
  const resolvedClass = className ?? classLevel?.name;
  if (!resolvedSubject) throw badRequest('Provide a subject.', { field: 'subjectCode or subjectName' });
  if (!resolvedClass) throw badRequest('Provide a class.', { field: 'classCode or className' });

  // Module 5: the teacher's default template applies unless overridden here.
  const template = templateCode
    ? await c.env.DB
        .prepare(`SELECT id FROM lesson_templates WHERE code = ? AND audience = 'TEACHER' AND is_active = 1`)
        .bind(templateCode).first<{ id: string }>()
    : teacher.default_template_id
      ? { id: teacher.default_template_id }
      : await c.env.DB.prepare(`SELECT id FROM lesson_templates WHERE code = 'STANDARD'`).first<{ id: string }>();
  if (!template) throw badRequest('No lesson template available.');

  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO lessons (id, teacher_id, template_id, subject_id, class_level_id, subject_name, class_name,
                          school_name, theme, topic, subtopic, week, term, lesson_date, duration_minutes,
                          class_size, average_age, sex_mix, curriculum, objectives, extra_instructions,
                          status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
  ).bind(
    id, auth.userId, template.id, subject?.id ?? null, classLevel?.id ?? null,
    resolvedSubject, resolvedClass, schoolName ?? teacher.school_name ?? null,
    theme ?? null, topic, subtopic ?? null, week ?? null, term ?? null, lessonDate ?? null,
    durationMinutes ?? null, classSize ?? null, averageAge ?? null, sexMix ?? null,
    curriculum ?? null,
    objectives && objectives.length > 0 ? JSON.stringify(objectives) : null,
    extraInstructions ?? null, nowIso(), nowIso(),
  ).run();

  await audit(c, {
    action: 'lesson.created', entityType: 'lesson', entityId: id,
    summary: `Created lesson "${topic}" for ${resolvedClass}.`,
  });

  return ok(c, await c.env.DB.prepare(`${LESSON_SELECT} WHERE l.id = ?`).bind(id).first(), 201);
});

lessonRoutes.patch('/:id', requirePermission('teacher.self.lessons.write'), async (c) => {
  const id = routeParam(c, 'id');
  const lesson = await loadLesson(c, id, 'write');
  if (lesson.status === 'GENERATING') {
    throw badRequest('This lesson is being generated. Wait for it to finish before editing.');
  }

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const fields: Record<string, unknown> = {
    topic: v.string('topic', { max: 200 }),
    subtopic: v.string('subtopic', { max: 200 }),
    theme: v.string('theme', { max: 200 }),
    school_name: v.string('schoolName', { max: 200 }),
    week: v.integer('week', { min: 1, max: 20 }),
    term: v.enum('term', ['FIRST', 'SECOND', 'THIRD'] as const),
    lesson_date: v.date('lessonDate'),
    duration_minutes: v.integer('durationMinutes', { min: 5, max: 240 }),
    class_size: v.integer('classSize', { min: 0, max: 500 }),
    average_age: v.integer('averageAge', { min: 2, max: 60 }),
    sex_mix: v.enum('sexMix', ['MIXED', 'MALE', 'FEMALE'] as const),
    curriculum: v.string('curriculum', { max: 300 }),
    extra_instructions: v.string('extraInstructions', { max: 2000 }),
  };
  const objectives = v.array<string>('objectives');
  const templateCode = v.string('templateCode', { max: 40 });
  v.assert();

  if (objectives) fields.objectives = objectives.length > 0 ? JSON.stringify(objectives) : null;
  if (templateCode) {
    const template = await c.env.DB
      .prepare(`SELECT id FROM lesson_templates WHERE code = ? AND audience = 'TEACHER' AND is_active = 1`)
      .bind(templateCode).first<{ id: string }>();
    if (!template) throw badRequest(`Unknown template ${templateCode}.`);
    fields.template_id = template.id;
  }

  const updates = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (updates.length === 0) return ok(c, { updated: false });

  await c.env.DB.prepare(
    `UPDATE lessons SET ${updates.map(([col]) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
  ).bind(...updates.map(([, value]) => value), nowIso(), id).run();

  await audit(c, { action: 'lesson.updated', entityType: 'lesson', entityId: id, summary: 'Updated lesson details.' });
  return ok(c, await c.env.DB.prepare(`${LESSON_SELECT} WHERE l.id = ?`).bind(id).first());
});

lessonRoutes.delete('/:id', requirePermission('teacher.self.lessons.write'), async (c) => {
  const id = routeParam(c, 'id');
  await loadLesson(c, id, 'write');

  // Soft delete: notes and generation cost records reference this lesson.
  await c.env.DB.prepare(`UPDATE lessons SET deleted_at = ?, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), nowIso(), id).run();

  await audit(c, { action: 'lesson.deleted', entityType: 'lesson', entityId: id,
                   summary: 'Deleted lesson.', severity: 'NOTICE' });
  return ok(c, { deleted: true });
});

// ------------------------------------------------------------ generation ----
/**
 * Module 4: AI writes the teacher's lesson note.
 *
 * Runs inline rather than queued. Generation takes tens of seconds, which fits
 * inside a Workers request, and the teacher is waiting on the result anyway --
 * a queue would add a polling endpoint and a job table for no benefit at this
 * scale. If generation grows past the request budget, the lesson status column
 * already models the async states a queue would need.
 */
lessonRoutes.post('/:id/generate', requirePermission('teacher.self.lessons.generate'),
  requireGenerationAllowance(), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const lesson = await loadLesson(c, id, 'write');

  // The slot is booked before the call and handed back if it fails, so a
  // provider error never costs the teacher one of their lesson plans.
  const booked = await consumeGeneration(c.env.DB, c.env, auth.userId);
  if (!booked.canGenerate) throw forbidden('You have no lesson plans left for this period.', { entitlement: booked });

  let result;
  try {
    result = await generateLessonNote({
      db: c.env.DB, env: c.env, lesson,
      teacherName: await teacherName(c.env.DB, lesson.teacher_id),
      requestedBy: auth.userId,
    });
  } catch (error) {
    if (booked.periodStart) await refundGeneration(c.env.DB, auth.userId, booked.periodStart);
    throw error;
  }

  await audit(c, {
    action: 'lesson.note_generated', entityType: 'lesson', entityId: id,
    summary: `Generated teacher note v${result.version}.`,
    metadata: { generationId: result.generationId, costKobo: result.usage.costKobo },
  });

  return ok(c, {
    noteId: result.noteId, version: result.version, kind: 'TEACHER_NOTE',
    usage: result.usage,
    allowance: { remaining: booked.quotaRemaining, limit: booked.quotaLimit, periodEnd: booked.periodEnd },
  }, 201);
});

/** Module 6: AI writes the student notes, from the teacher's note. */
lessonRoutes.post('/:id/generate-student-notes', requirePermission('teacher.self.lessons.generate'),
  requireGenerationAllowance(), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const lesson = await loadLesson(c, id, 'write');

  const booked = await consumeGeneration(c.env.DB, c.env, auth.userId);
  if (!booked.canGenerate) throw forbidden('You have no lesson plans left for this period.', { entitlement: booked });

  let result;
  try {
    result = await generateStudentNote({
      db: c.env.DB, env: c.env, lesson,
      teacherName: await teacherName(c.env.DB, lesson.teacher_id),
      requestedBy: auth.userId,
    });
  } catch (error) {
    if (booked.periodStart) await refundGeneration(c.env.DB, auth.userId, booked.periodStart);
    throw error;
  }

  await audit(c, {
    action: 'lesson.student_note_generated', entityType: 'lesson', entityId: id,
    summary: `Generated student notes v${result.version}.`,
    metadata: { generationId: result.generationId, costKobo: result.usage.costKobo },
  });

  return ok(c, {
    noteId: result.noteId, version: result.version, kind: 'STUDENT_NOTE',
    usage: result.usage,
    allowance: { remaining: booked.quotaRemaining, limit: booked.quotaLimit, periodEnd: booked.periodEnd },
  }, 201);
});

/** What this lesson has cost to generate so far. Feeds Module 12's expense line. */
lessonRoutes.get('/:id/generations', requirePermission('teacher.self.lessons.read', 'content.read'), async (c) => {
  const id = routeParam(c, 'id');
  await loadLesson(c, id, 'read');

  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, provider, model, status, input_tokens AS inputTokens,
            output_tokens AS outputTokens, cost_kobo AS costKobo, duration_ms AS durationMs,
            error, created_at AS createdAt, completed_at AS completedAt
       FROM ai_generations WHERE lesson_id = ? ORDER BY created_at DESC`,
  ).bind(id).all<{ cost_kobo: number | null; costKobo: number | null }>();

  const totalCostKobo = results.reduce((sum, row) => sum + (row.costKobo ?? 0), 0);
  return ok(c, { generations: results, totalCostKobo });
});

export { loadLesson, teacherName };
