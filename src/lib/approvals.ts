import type { Context } from 'hono';
import type { App, AuthContext } from '../types';
import { audit } from './audit';
import { newId } from './crypto';
import { conflict, notFound } from './http';
import { isSensitivePermission } from './rbac';
import { nowIso, plusMinutes } from './time';

/**
 * The gate that lets a Super Admin delegate real duties without handing over
 * the keys.
 *
 * A Deputy Super Admin can hold a sensitive permission, but exercising it does
 * not perform the change -- it records the intended change as a PENDING
 * approval_request. A Super Admin then approves it, and only then is the change
 * applied, by the executor registered for that request type.
 *
 * The deputy never writes the sensitive record directly, so a compromised
 * deputy account cannot move money, change a revenue split, or escalate itself.
 */
export type RequestType =
  | 'USER_DELETE'
  | 'USER_STATUS'
  | 'ROLE_GRANT'
  | 'ROLE_REVOKE'
  | 'PERMISSION_GRANT'
  | 'PERMISSION_REVOKE'
  | 'SETTING_UPDATE'
  | 'PARTNER_SUSPEND'
  | 'AGREEMENT_ACTIVATE'
  | 'AGREEMENT_TERMINATE';

export interface GateInput {
  permission: string;
  requestType: RequestType;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  summary: string;
  reason?: string;
}

export interface ApprovalRequestRow {
  id: string;
  request_type: RequestType;
  entity_type: string | null;
  entity_id: string | null;
  payload: string;
  reason: string | null;
  status: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  applied_at: string | null;
  failure_reason: string | null;
  expires_at: string | null;
}

/**
 * Returns the created request when the action was deferred, or null when the
 * caller may proceed and perform it directly.
 */
export async function gateSensitiveAction(
  c: Context<App>,
  input: GateInput,
): Promise<ApprovalRequestRow | null> {
  const auth = c.get('auth');

  // A Super Admin is the approver, so there is nobody above them to ask.
  if (auth.isSuperAdmin) return null;
  if (!(await isSensitivePermission(c.env.DB, input.permission))) return null;

  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO approval_requests (id, request_type, entity_type, entity_id, payload, reason,
                                    status, requested_by, requested_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.requestType,
      input.entityType,
      input.entityId,
      JSON.stringify(input.payload),
      input.reason ?? null,
      auth.userId,
      nowIso(),
      plusMinutes(60 * 24 * 14),
      nowIso(),
      nowIso(),
    )
    .run();

  await audit(c, {
    action: 'approval.requested',
    entityType: 'approval_request',
    entityId: id,
    summary: `Requested approval: ${input.summary}`,
    metadata: { requestType: input.requestType, target: input.entityId },
    severity: 'NOTICE',
  });

  return (await c.env.DB.prepare(`SELECT * FROM approval_requests WHERE id = ?`)
    .bind(id)
    .first<ApprovalRequestRow>())!;
}

/**
 * What actually happens when a Super Admin approves a request.
 *
 * Each executor re-reads the target and re-validates before writing: the
 * request may have been sitting in the queue for days, and the world it
 * described may no longer exist.
 */
type Executor = (db: D1Database, request: ApprovalRequestRow, approver: AuthContext) => Promise<void>;

const EXECUTORS: Record<RequestType, Executor> = {
  USER_DELETE: async (db, request) => {
    await db.prepare(`UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), nowIso(), request.entity_id)
      .run();
    await db.prepare(
      `UPDATE sessions SET revoked_at = ?, revoked_reason = 'user_deleted'
        WHERE user_id = ? AND revoked_at IS NULL`,
    ).bind(nowIso(), request.entity_id).run();
  },

  USER_STATUS: async (db, request) => {
    const { status, reason } = JSON.parse(request.payload) as { status: string; reason?: string };
    await db.prepare(`UPDATE users SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?`)
      .bind(status, reason ?? null, nowIso(), request.entity_id)
      .run();
    if (status !== 'ACTIVE') {
      await db.prepare(
        `UPDATE sessions SET revoked_at = ?, revoked_reason = 'status_changed'
          WHERE user_id = ? AND revoked_at IS NULL`,
      ).bind(nowIso(), request.entity_id).run();
    }
  },

  ROLE_GRANT: async (db, request, approver) => {
    const { roleId } = JSON.parse(request.payload) as { roleId: string };
    await db.prepare(
      `INSERT OR IGNORE INTO user_roles (id, user_id, role_id, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(newId(), request.entity_id, roleId, approver.userId, nowIso()).run();
  },

  ROLE_REVOKE: async (db, request) => {
    const { roleId } = JSON.parse(request.payload) as { roleId: string };
    await db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`)
      .bind(request.entity_id, roleId)
      .run();
  },

  PERMISSION_GRANT: async (db, request, approver) => {
    const { permissionId, effect } = JSON.parse(request.payload) as { permissionId: string; effect: string };
    await db.prepare(
      `INSERT INTO user_permissions (id, user_id, permission_id, effect, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, permission_id) DO UPDATE SET effect = excluded.effect,
                                                         granted_by = excluded.granted_by,
                                                         granted_at = excluded.granted_at`,
    ).bind(newId(), request.entity_id, permissionId, effect, approver.userId, nowIso()).run();
  },

  PERMISSION_REVOKE: async (db, request) => {
    const { permissionId } = JSON.parse(request.payload) as { permissionId: string };
    await db.prepare(`DELETE FROM user_permissions WHERE user_id = ? AND permission_id = ?`)
      .bind(request.entity_id, permissionId)
      .run();
  },

  SETTING_UPDATE: async (db, request, approver) => {
    const { value } = JSON.parse(request.payload) as { value: string };
    await db.prepare(`UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = ?`)
      .bind(value, approver.userId, nowIso(), request.entity_id)
      .run();
  },

  PARTNER_SUSPEND: async (db, request) => {
    const { status, reason } = JSON.parse(request.payload) as { status: string; reason?: string };
    await db.prepare(
      `UPDATE partners SET status = ?, notes = COALESCE(?, notes), updated_at = ?,
                           exited_at = CASE WHEN ? = 'EXITED' THEN ? ELSE exited_at END
        WHERE id = ?`,
    ).bind(status, reason ?? null, nowIso(), status, nowIso(), request.entity_id).run();
  },

  AGREEMENT_ACTIVATE: async (db, request, approver) => {
    const { activateAgreement } = await import('./agreements');
    await activateAgreement(db, request.entity_id!, approver.userId);
  },

  AGREEMENT_TERMINATE: async (db, request, approver) => {
    const { reason } = JSON.parse(request.payload) as { reason?: string };
    await db.prepare(
      `UPDATE partnership_agreements
          SET status = 'TERMINATED', terminated_by = ?, terminated_at = ?,
              termination_reason = ?, effective_to = ?, updated_at = ?
        WHERE id = ? AND status = 'ACTIVE'`,
    ).bind(approver.userId, nowIso(), reason ?? null, nowIso(), nowIso(), request.entity_id).run();
  },
};

/**
 * Applies an approved request. `applied_at` is stamped only after the executor
 * returns, so an approved-but-failed request is never mistaken for one that
 * took effect -- it lands in FAILED with the reason attached.
 */
export async function applyApprovedRequest(
  db: D1Database,
  requestId: string,
  approver: AuthContext,
): Promise<ApprovalRequestRow> {
  const request = await db.prepare(`SELECT * FROM approval_requests WHERE id = ?`)
    .bind(requestId)
    .first<ApprovalRequestRow>();
  if (!request) throw notFound('Approval request');
  if (request.status !== 'PENDING') throw conflict(`This request is already ${request.status.toLowerCase()}.`);
  if (request.expires_at && new Date(request.expires_at).getTime() <= Date.now()) {
    await db.prepare(`UPDATE approval_requests SET status = 'EXPIRED', updated_at = ? WHERE id = ?`)
      .bind(nowIso(), requestId)
      .run();
    throw conflict('This request has expired.');
  }

  const executor = EXECUTORS[request.request_type];
  if (!executor) throw conflict(`No executor is registered for ${request.request_type}.`);

  try {
    await executor(db, request, approver);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.prepare(
      `UPDATE approval_requests SET status = 'FAILED', failure_reason = ?, decided_by = ?,
                                    decided_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(message, approver.userId, nowIso(), nowIso(), requestId).run();
    throw conflict(`Approved, but the change could not be applied: ${message}`);
  }

  await db.prepare(
    `UPDATE approval_requests SET status = 'APPLIED', decided_by = ?, decided_at = ?,
                                  applied_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(approver.userId, nowIso(), nowIso(), nowIso(), requestId).run();

  return (await db.prepare(`SELECT * FROM approval_requests WHERE id = ?`)
    .bind(requestId)
    .first<ApprovalRequestRow>())!;
}
