import type { Context } from 'hono';
import { Hono } from 'hono';
import type { App } from '../types';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound, ok, routeParam } from '../lib/http';
import { generateSecretToken, newId } from '../lib/crypto';
import { loadLesson } from './lessons';
import { requirePermission } from '../lib/rbac';
import { toBlocks, toHtml, toMarkdown } from '../lib/render';
import { loadTemplate, validateContent } from '../lib/templates';
import { nowIso } from '../lib/time';
import { readJson, Validator } from '../lib/validate';

export const noteRoutes = new Hono<App>();

type NoteTable = 'lesson_notes' | 'student_notes';

interface NoteRow {
  id: string;
  lesson_id: string;
  template_id: string;
  version: number;
  title?: string | null;
  content: string;
  status: string;
  origin: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Loads a note and re-checks access through its lesson.
 *
 * The note id alone proves nothing -- authorisation always walks back to the
 * owning lesson, which is where ownership actually lives.
 */
async function loadNote(c: Context<App>, table: NoteTable, noteId: string, access: 'read' | 'write') {
  const note = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(noteId).first<NoteRow>();
  if (!note) throw notFound('Note');

  const lesson = await loadLesson(c, note.lesson_id, access);
  const { row: templateRow, structure } = await loadTemplate(c.env.DB, note.template_id);
  return { note, lesson, templateRow, structure };
}

function tableFor(kind: string): NoteTable {
  if (kind === 'teacher') return 'lesson_notes';
  if (kind === 'student') return 'student_notes';
  throw badRequest('Note kind must be "teacher" or "student".');
}

function noteTitle(lesson: { topic: string; class_name: string; subject_name: string }, table: NoteTable) {
  return table === 'lesson_notes'
    ? `${lesson.subject_name} - ${lesson.topic}`
    : `${lesson.topic} (${lesson.class_name})`;
}

// ------------------------------------------------------------- reading ----
noteRoutes.get('/:kind/:id', requirePermission('teacher.self.lessons.read', 'content.read'), async (c) => {
  const table = tableFor(routeParam(c, 'kind'));
  const { note, lesson, templateRow, structure } = await loadNote(c, table, routeParam(c, 'id'), 'read');
  const content = JSON.parse(note.content);

  return ok(c, {
    id: note.id,
    lessonId: note.lesson_id,
    version: note.version,
    status: note.status,
    origin: note.origin,
    publishedAt: note.published_at,
    template: { id: templateRow.id, code: templateRow.code, name: templateRow.name },
    structure,
    content,
    // Pre-rendered so the Flutter client can draw the note without
    // re-implementing the template walk.
    blocks: toBlocks(structure, content),
    title: noteTitle(lesson, table),
  });
});

/** Export formats. PDF/DOCX are produced client-side -- see render.ts. */
noteRoutes.get('/:kind/:id/export', requirePermission('teacher.self.lessons.read', 'content.read'), async (c) => {
  const table = tableFor(routeParam(c, 'kind'));
  const format = (c.req.query('format') ?? 'markdown').toLowerCase();
  const { note, lesson, structure } = await loadNote(c, table, routeParam(c, 'id'), 'read');
  const content = JSON.parse(note.content);
  const title = noteTitle(lesson, table);

  if (format === 'markdown') {
    return c.text(toMarkdown(structure, content, title), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
    });
  }
  if (format === 'html') {
    return c.html(toHtml(structure, content, {
      title,
      heading: table === 'lesson_notes' ? 'Lesson Note' : 'Student Notes',
      footer: 'Created with KamDova',
    }));
  }
  throw badRequest('Format must be "markdown" or "html".', { supported: ['markdown', 'html'] });
});

// ------------------------------------------------------------- editing ----
/**
 * Module 6 requires the teacher be able to edit the student notes before
 * publishing. Edits are validated against the same template the generator
 * filled, so a hand-edit cannot put the note into a shape the renderer
 * cannot draw.
 */
noteRoutes.patch('/:kind/:id', requirePermission('teacher.self.lessons.write'), async (c) => {
  const auth = c.get('auth');
  const table = tableFor(routeParam(c, 'kind'));
  const { note, structure } = await loadNote(c, table, routeParam(c, 'id'), 'write');

  if (note.status === 'SUPERSEDED' || note.status === 'ARCHIVED') {
    throw conflict(`A ${note.status.toLowerCase()} note cannot be edited.`);
  }

  const body = await readJson(c.req.raw);
  if (body.content === undefined) throw badRequest('Provide the note content to save.');

  const before = JSON.parse(note.content);
  // Merged, not replaced, so a client that sends one edited section does not
  // wipe the rest of the note.
  const merged = { ...before, ...(body.content as Record<string, unknown>) };
  const clean = validateContent(structure, merged);

  await c.env.DB.prepare(
    `UPDATE ${table} SET content = ?, origin = CASE origin WHEN 'AI' THEN 'AI_EDITED' ELSE origin END,
                         edited_by = ?, edited_at = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(JSON.stringify(clean), auth.userId, nowIso(), nowIso(), note.id).run();

  await audit(c, {
    action: 'note.edited', entityType: table, entityId: note.id,
    summary: `Edited ${table === 'lesson_notes' ? 'lesson note' : 'student notes'} v${note.version}.`,
    metadata: { sections: Object.keys(body.content as Record<string, unknown>) },
  });

  return ok(c, { id: note.id, updated: true, content: clean });
});

noteRoutes.post('/:kind/:id/publish', requirePermission('teacher.self.lessons.publish'), async (c) => {
  const table = tableFor(routeParam(c, 'kind'));
  const { note, structure } = await loadNote(c, table, routeParam(c, 'id'), 'write');

  if (note.status === 'PUBLISHED') return ok(c, { id: note.id, status: 'PUBLISHED', alreadyPublished: true });
  if (note.status !== 'DRAFT') throw conflict(`A ${note.status.toLowerCase()} note cannot be published.`);

  // Every generated section must be present and well-formed before this goes
  // anywhere a pupil can read it.
  validateContent(structure, JSON.parse(note.content), { requireGenerated: true });

  await c.env.DB.batch([
    // Only one published version at a time; the previous one is superseded.
    c.env.DB.prepare(
      `UPDATE ${table} SET status = 'SUPERSEDED', updated_at = ?
        WHERE lesson_id = ? AND status = 'PUBLISHED' AND id <> ?`,
    ).bind(nowIso(), note.lesson_id, note.id),
    c.env.DB.prepare(
      `UPDATE ${table} SET status = 'PUBLISHED', published_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), nowIso(), note.id),
  ]);

  await audit(c, {
    action: 'note.published', entityType: table, entityId: note.id,
    summary: `Published ${table === 'lesson_notes' ? 'lesson note' : 'student notes'} v${note.version}.`,
    severity: 'NOTICE',
  });

  return ok(c, { id: note.id, status: 'PUBLISHED' });
});

noteRoutes.post('/:kind/:id/unpublish', requirePermission('teacher.self.lessons.publish'), async (c) => {
  const table = tableFor(routeParam(c, 'kind'));
  const { note } = await loadNote(c, table, routeParam(c, 'id'), 'write');
  if (note.status !== 'PUBLISHED') throw conflict('That note is not published.');

  // Any live share links die with it -- unpublishing must actually revoke
  // access, not just hide the note from the app.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${table} SET status = 'DRAFT', published_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), note.id),
    ...(table === 'student_notes'
      ? [c.env.DB.prepare(
          `UPDATE note_shares SET revoked_at = ? WHERE student_note_id = ? AND revoked_at IS NULL`,
        ).bind(nowIso(), note.id)]
      : []),
  ]);

  await audit(c, {
    action: 'note.unpublished', entityType: table, entityId: note.id,
    summary: 'Unpublished the note and revoked its share links.', severity: 'WARNING',
  });
  return ok(c, { id: note.id, status: 'DRAFT' });
});

// -------------------------------------------------------------- sharing ----
/**
 * Module 6: "Copy link" / "Generate read-only student page".
 *
 * The slug carries 32 bytes of entropy, so links cannot be guessed or walked;
 * the row is revocable and can expire. Only a PUBLISHED student note can be
 * shared -- a link to a draft would leak work in progress.
 */
noteRoutes.post('/student/:id/shares', requirePermission('teacher.self.lessons.publish'), async (c) => {
  const auth = c.get('auth');
  const { note } = await loadNote(c, 'student_notes', routeParam(c, 'id'), 'write');
  if (note.status !== 'PUBLISHED') throw conflict('Publish the student notes before sharing them.');

  const body = await readJson(c.req.raw).catch(() => ({}) as Record<string, unknown>);
  const v = new Validator(body);
  const label = v.string('label', { max: 120 });
  const expiresAt = v.date('expiresAt');
  v.assert();

  const slug = generateSecretToken(24);
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO note_shares (id, student_note_id, slug, created_by, label, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, note.id, slug, auth.userId, label ?? null, expiresAt ?? null, nowIso()).run();

  await audit(c, {
    action: 'note.share_created', entityType: 'student_notes', entityId: note.id,
    summary: 'Created a read-only share link.', metadata: { shareId: id, expiresAt }, severity: 'NOTICE',
  });

  const base = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  return ok(c, {
    id, slug,
    url: `${base}/s/${slug}`,
    expiresAt: expiresAt ?? null,
  }, 201);
});

noteRoutes.get('/student/:id/shares', requirePermission('teacher.self.lessons.read'), async (c) => {
  const { note } = await loadNote(c, 'student_notes', routeParam(c, 'id'), 'read');
  const base = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;

  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, label, expires_at AS expiresAt, revoked_at AS revokedAt,
            view_count AS viewCount, last_viewed_at AS lastViewedAt, created_at AS createdAt
       FROM note_shares WHERE student_note_id = ? ORDER BY created_at DESC`,
  ).bind(note.id).all<{ slug: string }>();

  return ok(c, results.map((row) => ({ ...row, url: `${base}/s/${row.slug}` })));
});

noteRoutes.delete('/student/:id/shares/:shareId', requirePermission('teacher.self.lessons.publish'), async (c) => {
  const auth = c.get('auth');
  const { note } = await loadNote(c, 'student_notes', routeParam(c, 'id'), 'write');
  const shareId = routeParam(c, 'shareId');

  // Scoped to this note, so a share id from another teacher's note cannot be
  // revoked by guessing it.
  const result = await c.env.DB.prepare(
    `UPDATE note_shares SET revoked_at = ?, revoked_by = ?
      WHERE id = ? AND student_note_id = ? AND revoked_at IS NULL`,
  ).bind(nowIso(), auth.userId, shareId, note.id).run();

  if (result.meta.changes === 0) throw notFound('Share link');

  await audit(c, {
    action: 'note.share_revoked', entityType: 'student_notes', entityId: note.id,
    summary: 'Revoked a share link.', metadata: { shareId }, severity: 'NOTICE',
  });
  return ok(c, { revoked: true });
});
