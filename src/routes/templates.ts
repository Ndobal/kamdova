import { Hono } from 'hono';
import type { App } from '../types';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound, ok, routeParam } from '../lib/http';
import { requirePermission } from '../lib/rbac';
import { nowIso } from '../lib/time';
import { newId } from '../lib/crypto';
import { buildOutputSchema, parseStructure, type LessonTemplateRow, type TemplateStructure } from '../lib/templates';
import { readJson, Validator } from '../lib/validate';

export const templateRoutes = new Hono<App>();

const shape = (row: LessonTemplateRow) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  audience: row.audience,
  version: row.version,
  isSystem: row.is_system === 1,
  structure: JSON.parse(row.structure) as TemplateStructure,
});

templateRoutes.get('/', requirePermission('templates.read'), async (c) => {
  const audience = c.req.query('audience') ?? 'TEACHER';
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM lesson_templates WHERE audience = ? AND is_active = 1 ORDER BY sort_order`,
  ).bind(audience).all<LessonTemplateRow>();

  return ok(c, results.map((row) => ({
    ...shape(row),
    // The section list is what the Flutter client needs to render a template
    // picker and, later, a section-by-section editor.
    sectionCount: JSON.parse(row.structure).sections.length,
  })));
});

templateRoutes.get('/:code', requirePermission('templates.read'), async (c) => {
  const row = await c.env.DB
    .prepare(`SELECT * FROM lesson_templates WHERE code = ? AND is_active = 1`)
    .bind(routeParam(c, 'code'))
    .first<LessonTemplateRow>();
  if (!row) throw notFound('Template');
  return ok(c, shape(row));
});

/**
 * The JSON Schema this template will make the model fill.
 *
 * Exposed because it is the honest answer to "what exactly will the AI write?"
 * -- useful when designing a template, and the fastest way to see that a
 * malformed structure produces a malformed schema before any tokens are spent.
 */
templateRoutes.get('/:code/schema', requirePermission('templates.read'), async (c) => {
  const row = await c.env.DB
    .prepare(`SELECT * FROM lesson_templates WHERE code = ? AND is_active = 1`)
    .bind(routeParam(c, 'code'))
    .first<LessonTemplateRow>();
  if (!row) throw notFound('Template');
  return ok(c, { code: row.code, schema: buildOutputSchema(parseStructure(row)) });
});

// ------------------------------------------------------- administration ----
templateRoutes.post('/', requirePermission('templates.manage'), async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const code = v.string('code', { required: true, max: 40 });
  const name = v.string('name', { required: true, max: 200 });
  const description = v.string('description', { max: 500 });
  const audience = v.enum('audience', ['TEACHER', 'STUDENT'] as const) ?? 'TEACHER';
  v.assert();

  if (!body.structure) throw badRequest('A template needs a structure.');

  const taken = await c.env.DB.prepare(`SELECT id FROM lesson_templates WHERE code = ?`).bind(code).first();
  if (taken) throw conflict(`Template code ${code} is already in use.`);

  const structure = JSON.stringify(body.structure);
  // Parsed and schema-built before it is stored: a template that cannot
  // produce a schema is useless, and finding that out at generation time
  // means a teacher discovers it instead of the admin who wrote it.
  const parsed = parseStructure({ structure, code: code! });
  buildOutputSchema(parsed);

  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO lesson_templates (id, code, name, description, audience, structure,
                                   version, is_system, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  ).bind(id, code, name, description ?? null, audience, structure, auth.userId, nowIso(), nowIso()).run();

  await audit(c, {
    action: 'template.created', entityType: 'lesson_template', entityId: id,
    summary: `Created template ${code}.`, severity: 'NOTICE',
  });
  return ok(c, { id, code, name, audience }, 201);
});

templateRoutes.put('/:code', requirePermission('templates.manage'), async (c) => {
  const code = routeParam(c, 'code');
  const row = await c.env.DB.prepare(`SELECT * FROM lesson_templates WHERE code = ?`)
    .bind(code).first<LessonTemplateRow>();
  if (!row) throw notFound('Template');

  const body = await readJson(c.req.raw);
  if (!body.structure) throw badRequest('A template needs a structure.');

  const structure = JSON.stringify(body.structure);
  const parsed = parseStructure({ structure, code });
  buildOutputSchema(parsed);

  await c.env.DB.prepare(
    `UPDATE lesson_templates SET structure = ?, name = COALESCE(?, name),
                                 description = COALESCE(?, description),
                                 version = version + 1, updated_at = ?
      WHERE id = ?`,
  ).bind(structure, body.name ?? null, body.description ?? null, nowIso(), row.id).run();

  await audit(c, {
    action: 'template.updated', entityType: 'lesson_template', entityId: row.id,
    summary: `Updated template ${code} to v${row.version + 1}.`,
    before: { structure: JSON.parse(row.structure) }, after: { structure: body.structure },
    severity: 'WARNING',
  });

  // Existing notes keep the structure they were generated against, because
  // lesson_notes stores its own template_id and content -- editing a template
  // never retroactively breaks a note a teacher already published.
  return ok(c, { code, version: row.version + 1 });
});
