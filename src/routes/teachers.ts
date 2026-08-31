import { Hono } from 'hono';
import type { App } from '../types';
import { audit } from '../lib/audit';
import { badRequest, notFound, ok, paginated, readPagination, routeParam } from '../lib/http';
import { requirePermission } from '../lib/rbac';
import { nowIso } from '../lib/time';
import { readJson, Validator } from '../lib/validate';

export const teacherRoutes = new Hono<App>();

/**
 * Ensures the caller has a teacher record, creating it on first use.
 *
 * A user gets the TEACHER role at registration but has no teacher row until
 * they open the teacher area. Creating it lazily here avoids a migration that
 * would have to guess which existing users are teachers.
 */
export async function ensureTeacher(db: D1Database, userId: string) {
  const existing = await db.prepare(`SELECT * FROM teachers WHERE user_id = ?`).bind(userId).first();
  if (existing) return existing;

  const template = await db
    .prepare(`SELECT id FROM lesson_templates WHERE code = 'STANDARD'`)
    .first<{ id: string }>();

  await db
    .prepare(
      `INSERT INTO teachers (user_id, default_template_id, status, created_at, updated_at)
       VALUES (?, ?, 'PENDING', ?, ?)`,
    )
    .bind(userId, template?.id ?? null, nowIso(), nowIso())
    .run();

  return await db.prepare(`SELECT * FROM teachers WHERE user_id = ?`).bind(userId).first();
}

async function teacherPayload(db: D1Database, userId: string) {
  const [teacher, subjects, classes] = await Promise.all([
    db.prepare(
      `SELECT t.user_id AS userId, t.school_name AS schoolName, t.school_address AS schoolAddress,
              t.qualifications, t.years_experience AS yearsExperience, t.headline,
              t.default_template_id AS defaultTemplateId, t.status, t.approved_at AS approvedAt,
              t.rejection_reason AS rejectionReason,
              tpl.code AS defaultTemplateCode, tpl.name AS defaultTemplateName,
              p.display_name AS displayName, u.email
         FROM teachers t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN profiles p ON p.user_id = t.user_id
         LEFT JOIN lesson_templates tpl ON tpl.id = t.default_template_id
        WHERE t.user_id = ?`,
    ).bind(userId).first<{ userId: string } & Record<string, unknown>>(),
    db.prepare(
      `SELECT s.id, s.code, s.name FROM teacher_subjects ts
         JOIN subjects s ON s.id = ts.subject_id WHERE ts.teacher_id = ? ORDER BY s.sort_order`,
    ).bind(userId).all(),
    db.prepare(
      `SELECT c.id, c.code, c.name, c.stage FROM teacher_classes tc
         JOIN class_levels c ON c.id = tc.class_level_id WHERE tc.teacher_id = ? ORDER BY c.sort_order`,
    ).bind(userId).all(),
  ]);

  return { ...(teacher ?? {}), subjects: subjects.results, classes: classes.results } as
    { userId?: string } & Record<string, unknown>;
}

// ------------------------------------------------------------ own record ----
teacherRoutes.get('/me', requirePermission('teacher.self.profile.read'), async (c) => {
  const auth = c.get('auth');
  await ensureTeacher(c.env.DB, auth.userId);
  return ok(c, await teacherPayload(c.env.DB, auth.userId));
});

teacherRoutes.patch('/me', requirePermission('teacher.self.profile.update'), async (c) => {
  const auth = c.get('auth');
  await ensureTeacher(c.env.DB, auth.userId);

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const fields: Record<string, unknown> = {
    school_name: v.string('schoolName', { max: 200 }),
    school_address: v.string('schoolAddress', { max: 300 }),
    qualifications: v.string('qualifications', { max: 500 }),
    years_experience: v.integer('yearsExperience', { min: 0, max: 70 }),
    headline: v.string('headline', { max: 200 }),
  };
  const defaultTemplateCode = v.string('defaultTemplateCode', { max: 40 });
  v.assert();

  // Module 5: the teacher picks a default template, and every new lesson
  // starts from it unless they choose otherwise.
  if (defaultTemplateCode) {
    const template = await c.env.DB
      .prepare(`SELECT id FROM lesson_templates WHERE code = ? AND audience = 'TEACHER' AND is_active = 1`)
      .bind(defaultTemplateCode)
      .first<{ id: string }>();
    if (!template) throw badRequest(`Unknown lesson template ${defaultTemplateCode}.`);
    fields.default_template_id = template.id;
  }

  const updates = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (updates.length === 0) return ok(c, { updated: false });

  await c.env.DB
    .prepare(`UPDATE teachers SET ${updates.map(([col]) => `${col} = ?`).join(', ')}, updated_at = ? WHERE user_id = ?`)
    .bind(...updates.map(([, value]) => value), nowIso(), auth.userId)
    .run();

  await audit(c, {
    action: 'teacher.profile_updated', entityType: 'teacher', entityId: auth.userId,
    summary: 'Updated own teacher profile.',
  });
  return ok(c, await teacherPayload(c.env.DB, auth.userId));
});

/** Replaces the whole set, so the client sends the full selection each time. */
async function replaceLinks(
  db: D1Database,
  table: 'teacher_subjects' | 'teacher_classes',
  column: 'subject_id' | 'class_level_id',
  refTable: 'subjects' | 'class_levels',
  teacherId: string,
  codes: string[],
) {
  const { results } = codes.length
    ? await db
        .prepare(`SELECT id, code FROM ${refTable} WHERE code IN (${codes.map(() => '?').join(',')})`)
        .bind(...codes)
        .all<{ id: string; code: string }>()
    : { results: [] as { id: string; code: string }[] };

  if (results.length !== codes.length) {
    const found = results.map((row) => row.code);
    throw badRequest('Unknown code.', { unknown: codes.filter((code) => !found.includes(code)) });
  }

  await db.batch([
    db.prepare(`DELETE FROM ${table} WHERE teacher_id = ?`).bind(teacherId),
    ...results.map((row) =>
      db.prepare(`INSERT INTO ${table} (teacher_id, ${column}, created_at) VALUES (?, ?, ?)`)
        .bind(teacherId, row.id, nowIso()),
    ),
  ]);
}

teacherRoutes.put('/me/subjects', requirePermission('teacher.self.profile.update'), async (c) => {
  const auth = c.get('auth');
  await ensureTeacher(c.env.DB, auth.userId);
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const codes = v.array<string>('subjects', { required: true });
  v.assert();

  await replaceLinks(c.env.DB, 'teacher_subjects', 'subject_id', 'subjects', auth.userId, codes!);
  await audit(c, { action: 'teacher.subjects_set', entityType: 'teacher', entityId: auth.userId,
                   summary: `Set ${codes!.length} subject(s).` });
  return ok(c, await teacherPayload(c.env.DB, auth.userId));
});

teacherRoutes.put('/me/classes', requirePermission('teacher.self.profile.update'), async (c) => {
  const auth = c.get('auth');
  await ensureTeacher(c.env.DB, auth.userId);
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const codes = v.array<string>('classes', { required: true });
  v.assert();

  await replaceLinks(c.env.DB, 'teacher_classes', 'class_level_id', 'class_levels', auth.userId, codes!);
  await audit(c, { action: 'teacher.classes_set', entityType: 'teacher', entityId: auth.userId,
                   summary: `Set ${codes!.length} class(es).` });
  return ok(c, await teacherPayload(c.env.DB, auth.userId));
});

// ------------------------------------------------------- administration ----
teacherRoutes.get('/', requirePermission('teachers.read'), async (c) => {
  const { page, perPage, offset } = readPagination(c);
  const status = c.req.query('status');
  const search = c.req.query('search')?.trim();

  const filters: string[] = ['u.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (status) { filters.push('t.status = ?'); params.push(status); }
  if (search) {
    filters.push('(u.email LIKE ? OR p.display_name LIKE ? OR t.school_name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${filters.join(' AND ')}`;

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM teachers t JOIN users u ON u.id = t.user_id
       LEFT JOIN profiles p ON p.user_id = t.user_id ${where}`,
  ).bind(...params).first<{ total: number }>();

  const { results } = await c.env.DB.prepare(
    `SELECT t.user_id AS userId, u.email, p.display_name AS displayName,
            t.school_name AS schoolName, t.status, t.years_experience AS yearsExperience,
            t.created_at AS createdAt,
            (SELECT COUNT(*) FROM lessons l WHERE l.teacher_id = t.user_id AND l.deleted_at IS NULL) AS lessonCount
       FROM teachers t JOIN users u ON u.id = t.user_id
       LEFT JOIN profiles p ON p.user_id = t.user_id
       ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...params, perPage, offset).all();

  return paginated(c, results, { page, perPage, total: countRow?.total ?? 0 });
});

teacherRoutes.get('/:id', requirePermission('teachers.read'), async (c) => {
  const payload = await teacherPayload(c.env.DB, routeParam(c, 'id'));
  if (!payload.userId) throw notFound('Teacher');
  return ok(c, payload);
});

teacherRoutes.post('/:id/status', requirePermission('teachers.approve'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const status = v.enum('status', ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] as const, { required: true });
  const reason = v.string('reason', { max: 500 });
  v.assert();

  const teacher = await c.env.DB.prepare(`SELECT user_id, status FROM teachers WHERE user_id = ?`)
    .bind(id).first<{ user_id: string; status: string }>();
  if (!teacher) throw notFound('Teacher');

  await c.env.DB.prepare(
    `UPDATE teachers SET status = ?, rejection_reason = ?, approved_by = ?, approved_at = ?, updated_at = ?
      WHERE user_id = ?`,
  ).bind(
    status, status === 'REJECTED' ? (reason ?? null) : null,
    status === 'APPROVED' ? auth.userId : null,
    status === 'APPROVED' ? nowIso() : null,
    nowIso(), id,
  ).run();

  await audit(c, {
    action: 'teacher.status_changed', entityType: 'teacher', entityId: id,
    summary: `Teacher ${teacher.status} -> ${status}.`,
    before: { status: teacher.status }, after: { status, reason }, severity: 'WARNING',
  });
  return ok(c, { userId: id, status });
});

// ------------------------------------------------------------- reference ----
export const referenceRoutes = new Hono<App>();

referenceRoutes.get('/subjects', async (c) => {
  const stage = c.req.query('stage');
  const { results } = stage
    ? await c.env.DB.prepare(
        `SELECT id, code, name, stage FROM subjects
          WHERE is_active = 1 AND (stage IS NULL OR stage = ?) ORDER BY sort_order`,
      ).bind(stage).all()
    : await c.env.DB.prepare(
        `SELECT id, code, name, stage FROM subjects WHERE is_active = 1 ORDER BY sort_order`,
      ).all();
  return ok(c, results);
});

referenceRoutes.get('/class-levels', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, code, name, stage, typical_age AS typicalAge FROM class_levels
      WHERE is_active = 1 ORDER BY sort_order`,
  ).all();
  return ok(c, results);
});
