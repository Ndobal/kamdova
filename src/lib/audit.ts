import type { Context } from 'hono';
import type { App } from '../types';
import { newId } from './crypto';
import { nowIso } from './time';

export type Severity = 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  summary?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  severity?: Severity;
}

/**
 * Writes one append-only line to the audit trail.
 *
 * Actor identity is denormalised into the row (email and roles, not just the
 * id) so the log still reads correctly after the user is renamed or removed.
 *
 * Auditing never fails the request it is describing: if the insert throws, the
 * error is logged and the caller proceeds. The alternative -- rolling back a
 * completed action because its audit line could not be written -- is worse.
 */
export async function audit(c: Context<App>, entry: AuditEntry): Promise<void> {
  const auth = c.get('auth');
  try {
    await c.env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_email, actor_roles, action, entity_type,
                               entity_id, summary, before_json, after_json, metadata,
                               ip_address, user_agent, request_id, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId(),
        auth?.userId ?? null,
        auth?.email ?? null,
        auth ? JSON.stringify(auth.roles) : null,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.summary ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        clientIp(c),
        c.req.header('User-Agent') ?? null,
        c.get('requestId') ?? null,
        entry.severity ?? 'INFO',
        nowIso(),
      )
      .run();
  } catch (error) {
    console.error('audit write failed', entry.action, error);
  }
}

/**
 * Audit line for an actor who is not yet authenticated -- a failed login, a
 * password reset request. Identity comes from the attempt, not from a session.
 */
export async function auditAnonymous(
  c: Context<App>,
  entry: AuditEntry & { actorEmail?: string; actorId?: string },
): Promise<void> {
  try {
    await c.env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_email, action, entity_type, entity_id,
                               summary, metadata, ip_address, user_agent, request_id, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId(),
        entry.actorId ?? null,
        entry.actorEmail ?? null,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.summary ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        clientIp(c),
        c.req.header('User-Agent') ?? null,
        c.get('requestId') ?? null,
        entry.severity ?? 'INFO',
        nowIso(),
      )
      .run();
  } catch (error) {
    console.error('audit write failed', entry.action, error);
  }
}

export const clientIp = (c: Context): string | null =>
  c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? null;
