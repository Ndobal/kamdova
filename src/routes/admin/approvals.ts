import { Hono } from 'hono';
import type { App } from '../../types';
import { applyApprovedRequest } from '../../lib/approvals';
import { audit } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound, ok, paginated, readPagination, routeParam } from '../../lib/http';
import { requirePermission, requireSuperAdmin } from '../../lib/rbac';
import { nowIso } from '../../lib/time';
import { readJson, Validator } from '../../lib/validate';

export const adminApprovalRoutes = new Hono<App>();

adminApprovalRoutes.get('/', requirePermission('approvals.read'), async (c) => {
  const auth = c.get('auth');
  const { page, perPage, offset } = readPagination(c);
  const status = c.req.query('status') ?? 'PENDING';

  // Built with the `ar.` prefix up front so the same clause serves both the
  // count and the joined query.
  const filters = ['ar.status = ?'];
  const params: unknown[] = [status];

  // A deputy sees the requests they raised. Only a Super Admin sees everyone's.
  if (!auth.isSuperAdmin) {
    filters.push('ar.requested_by = ?');
    params.push(auth.userId);
  }

  const where = `WHERE ${filters.join(' AND ')}`;
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM approval_requests ar ${where}`,
  ).bind(...params).first<{ total: number }>();

  const { results } = await c.env.DB.prepare(
    `SELECT ar.id, ar.request_type AS requestType, ar.entity_type AS entityType, ar.entity_id AS entityId,
            ar.payload, ar.reason, ar.status, ar.requested_by AS requestedBy, ar.requested_at AS requestedAt,
            ar.decided_by AS decidedBy, ar.decided_at AS decidedAt, ar.decision_note AS decisionNote,
            ar.applied_at AS appliedAt, ar.failure_reason AS failureReason, ar.expires_at AS expiresAt,
            u.email AS requestedByEmail
       FROM approval_requests ar LEFT JOIN users u ON u.id = ar.requested_by
       ${where}
      ORDER BY ar.requested_at DESC LIMIT ? OFFSET ?`,
  ).bind(...params, perPage, offset).all();

  return paginated(
    c,
    results.map((row) => ({ ...row, payload: row.payload ? JSON.parse(String(row.payload)) : null })),
    { page, perPage, total: countRow?.total ?? 0 },
  );
});

/**
 * Deciding is Super Admin only, and separate from approvals.read on purpose:
 * a deputy may watch the queue, but the decision is what the whole gate exists
 * to reserve.
 */
adminApprovalRoutes.post('/:id/decide', requireSuperAdmin, async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const decision = v.enum('decision', ['APPROVE', 'REJECT'] as const, { required: true });
  const note = v.string('note', { max: 500 });
  v.assert();

  const request = await c.env.DB.prepare(`SELECT * FROM approval_requests WHERE id = ?`)
    .bind(id).first<{ id: string; status: string; requested_by: string; request_type: string; entity_id: string }>();
  if (!request) throw notFound('Approval request');
  if (request.status !== 'PENDING') throw conflict(`This request is already ${request.status.toLowerCase()}.`);

  // Nobody signs off their own request, Super Admin included.
  if (request.requested_by === auth.userId) {
    throw forbidden('You cannot decide a request you raised yourself.');
  }

  if (decision === 'REJECT') {
    await c.env.DB.prepare(
      `UPDATE approval_requests SET status = 'REJECTED', decided_by = ?, decided_at = ?,
                                    decision_note = ?, updated_at = ? WHERE id = ?`,
    ).bind(auth.userId, nowIso(), note ?? null, nowIso(), id).run();

    await audit(c, {
      action: 'approval.rejected', entityType: 'approval_request', entityId: id,
      summary: `Rejected ${request.request_type} on ${request.entity_id}.`,
      metadata: { note }, severity: 'WARNING',
    });
    return ok(c, { id, status: 'REJECTED' });
  }

  const applied = await applyApprovedRequest(c.env.DB, id, auth);

  await audit(c, {
    action: 'approval.applied', entityType: 'approval_request', entityId: id,
    summary: `Approved and applied ${request.request_type} on ${request.entity_id}.`,
    metadata: { note }, severity: 'CRITICAL',
  });

  return ok(c, { id, status: applied.status, appliedAt: applied.applied_at });
});

/** A requester may withdraw their own pending request. */
adminApprovalRoutes.post('/:id/cancel', requirePermission('approvals.read'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');

  const request = await c.env.DB.prepare(
    `SELECT id, status, requested_by FROM approval_requests WHERE id = ?`,
  ).bind(id).first<{ id: string; status: string; requested_by: string }>();
  if (!request) throw notFound('Approval request');
  if (request.status !== 'PENDING') throw badRequest('Only a pending request can be cancelled.');
  if (request.requested_by !== auth.userId && !auth.isSuperAdmin) {
    throw forbidden('You can only cancel a request you raised.');
  }

  await c.env.DB.prepare(
    `UPDATE approval_requests SET status = 'CANCELLED', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(auth.userId, nowIso(), nowIso(), id).run();

  await audit(c, {
    action: 'approval.cancelled', entityType: 'approval_request', entityId: id,
    summary: 'Cancelled the request.', severity: 'NOTICE',
  });
  return ok(c, { id, status: 'CANCELLED' });
});
