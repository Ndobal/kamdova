import { Hono } from 'hono';
import type { App } from '../../types';
import { notFound, ok, paginated, readPagination, routeParam } from '../../lib/http';
import { requirePermission } from '../../lib/rbac';

export const adminAuditRoutes = new Hono<App>();

/**
 * Read-only by design. There is no POST, PATCH or DELETE on this router and no
 * code path anywhere that updates or removes an audit row -- a trail that can
 * be edited is not a trail.
 */
adminAuditRoutes.get('/', requirePermission('audit.read'), async (c) => {
  const { page, perPage, offset } = readPagination(c);

  const filters: string[] = [];
  const params: unknown[] = [];
  const addFilter = (clause: string, value: unknown) => {
    filters.push(clause);
    params.push(value);
  };

  const actorId = c.req.query('actorId');
  const action = c.req.query('action');
  const entityType = c.req.query('entityType');
  const entityId = c.req.query('entityId');
  const severity = c.req.query('severity');
  const from = c.req.query('from');
  const to = c.req.query('to');

  if (actorId) addFilter('actor_id = ?', actorId);
  if (action) addFilter('action LIKE ?', `${action}%`);
  if (entityType) addFilter('entity_type = ?', entityType);
  if (entityId) addFilter('entity_id = ?', entityId);
  if (severity) addFilter('severity = ?', severity);
  if (from) addFilter('created_at >= ?', from);
  if (to) addFilter('created_at <= ?', to);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_logs ${where}`)
    .bind(...params).first<{ total: number }>();

  const { results } = await c.env.DB.prepare(
    `SELECT id, actor_id AS actorId, actor_email AS actorEmail, actor_roles AS actorRoles,
            action, entity_type AS entityType, entity_id AS entityId, summary,
            ip_address AS ipAddress, severity, created_at AS createdAt
       FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...params, perPage, offset).all();

  return paginated(
    c,
    results.map((row) => ({
      ...row,
      actorRoles: row.actorRoles ? JSON.parse(String(row.actorRoles)) : [],
    })),
    { page, perPage, total: countRow?.total ?? 0 },
  );
});

/** The before/after payloads are only sent on the detail view -- they can be large. */
adminAuditRoutes.get('/:id', requirePermission('audit.read'), async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM audit_logs WHERE id = ?`)
    .bind(routeParam(c, 'id')).first<Record<string, string | null>>();
  if (!row) throw notFound('Audit entry');

  const parse = (value: string | null | undefined) => {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  };

  return ok(c, {
    id: row.id,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    actorRoles: parse(row.actor_roles),
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    before: parse(row.before_json),
    after: parse(row.after_json),
    metadata: parse(row.metadata),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    requestId: row.request_id,
    severity: row.severity,
    createdAt: row.created_at,
  });
});
