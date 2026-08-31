import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { App, AuthContext } from '../types';
import { forbidden, unauthorized } from './http';
import { verifyAccessToken } from './tokens';
import { ACCESS_COOKIE } from './cookies';
import { nowIso } from './time';

export const SUPER_ADMIN = 'SUPER_ADMIN';
export const DEPUTY_SUPER_ADMIN = 'DEPUTY_SUPER_ADMIN';

/**
 * Resolves what a user may actually do, right now.
 *
 * Effective permissions = (permissions of every unexpired role)
 *                       + (individual GRANT overrides)
 *                       - (individual DENY overrides)          <- DENY always wins
 *
 * This is read from D1 on every authenticated request rather than trusted from
 * the JWT claims. It costs one batched round trip, and it buys the property
 * that matters in an admin system holding financial controls: revoking a
 * permission takes effect immediately, not whenever the access token expires.
 */
export async function resolveAuthContext(
  db: D1Database,
  input: { userId: string; email: string; sessionId: string },
): Promise<AuthContext> {
  const at = nowIso();

  const batched = await db.batch([
    db
      .prepare(
        `SELECT r.code AS code
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = ?1
            AND (ur.expires_at IS NULL OR ur.expires_at > ?2)`,
      )
      .bind(input.userId, at),
    db
      .prepare(
        `SELECT p.code AS code, 'GRANT' AS effect
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE ur.user_id = ?1
            AND (ur.expires_at IS NULL OR ur.expires_at > ?2)
          UNION ALL
         SELECT p.code AS code, up.effect AS effect
           FROM user_permissions up
           JOIN permissions p ON p.id = up.permission_id
          WHERE up.user_id = ?1
            AND (up.expires_at IS NULL OR up.expires_at > ?2)`,
      )
      .bind(input.userId, at),
    db
      .prepare(`SELECT id FROM partners WHERE user_id = ? AND deleted_at IS NULL`)
      .bind(input.userId),
  ]);
  const [rolesResult, permissionsResult, partnerResult] = [batched[0]!, batched[1]!, batched[2]!];

  const roles = (rolesResult.results as { code: string }[]).map((row) => row.code);
  const isSuperAdmin = roles.includes(SUPER_ADMIN);

  const granted = new Set<string>();
  const denied = new Set<string>();
  for (const row of permissionsResult.results as { code: string; effect: string }[]) {
    if (row.effect === 'DENY') denied.add(row.code);
    else granted.add(row.code);
  }
  for (const code of denied) granted.delete(code);

  const partnerRow = (partnerResult.results as { id: string }[])[0];

  return {
    userId: input.userId,
    email: input.email,
    sessionId: input.sessionId,
    roles,
    permissions: [...granted].sort(),
    isSuperAdmin,
    partnerId: partnerRow?.id ?? null,
  };
}

/** Bearer header first (Flutter), cookie second (browser dashboard). */
function readAccessToken(c: Context): string | null {
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return getCookie(c, ACCESS_COOKIE) ?? null;
}

export async function requireAuth(c: Context<App>, next: Next) {
  const token = readAccessToken(c);
  if (!token) throw unauthorized();

  const payload = await verifyAccessToken(c.env, token);
  if (!payload) throw unauthorized('Session expired or invalid.');

  // The JWT proves identity; the session row proves the session is still alive.
  const session = await c.env.DB.prepare(
    `SELECT s.id, s.revoked_at, s.expires_at, u.status, u.deleted_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ?`,
  )
    .bind(payload.sid, payload.sub)
    .first<{ id: string; revoked_at: string | null; expires_at: string; status: string; deleted_at: string | null }>();

  if (!session || session.revoked_at) throw unauthorized('Session has been revoked.');
  if (session.deleted_at) throw unauthorized('Account no longer exists.');
  if (session.status !== 'ACTIVE') throw unauthorized(`Account is ${session.status.toLowerCase()}.`);

  c.set('auth', await resolveAuthContext(c.env.DB, {
    userId: payload.sub,
    email: payload.email,
    sessionId: payload.sid,
  }));
  await next();
}

const has = (auth: AuthContext, code: string) => auth.isSuperAdmin || auth.permissions.includes(code);

/** Passes when the user holds ANY of the listed permissions. */
export function requirePermission(...codes: string[]) {
  return async (c: Context<App>, next: Next) => {
    const auth = c.get('auth');
    if (!codes.some((code) => has(auth, code))) {
      throw forbidden('You do not have permission to do that.', { required: codes });
    }
    await next();
  };
}

/** Passes only when the user holds EVERY listed permission. */
export function requireAllPermissions(...codes: string[]) {
  return async (c: Context<App>, next: Next) => {
    const auth = c.get('auth');
    const missing = codes.filter((code) => !has(auth, code));
    if (missing.length > 0) throw forbidden('You do not have permission to do that.', { missing });
    await next();
  };
}

export function requireRole(...roleCodes: string[]) {
  return async (c: Context<App>, next: Next) => {
    const auth = c.get('auth');
    if (!roleCodes.some((role) => auth.roles.includes(role))) {
      throw forbidden('Your role does not allow that.', { required: roleCodes });
    }
    await next();
  };
}

export const requireSuperAdmin = requireRole(SUPER_ADMIN);

export const hasPermission = has;

/** Sensitive permissions are the ones a deputy must route through an approval. */
export async function isSensitivePermission(db: D1Database, code: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT is_sensitive FROM permissions WHERE code = ?`)
    .bind(code)
    .first<{ is_sensitive: number }>();
  return row?.is_sensitive === 1;
}

/**
 * Stops a deputy from editing, or escalating themselves to, an equal-or-higher
 * authority. Returns the target rank so callers can report it.
 */
export async function assertOutranks(db: D1Database, auth: AuthContext, targetUserId: string) {
  if (auth.isSuperAdmin) return;
  if (auth.userId === targetUserId) return;

  const target = await db
    .prepare(
      `SELECT COALESCE(MAX(r.rank), 0) AS rank
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ?`,
    )
    .bind(targetUserId)
    .first<{ rank: number }>();

  const actor = await db
    .prepare(
      `SELECT COALESCE(MAX(r.rank), 0) AS rank
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ?`,
    )
    .bind(auth.userId)
    .first<{ rank: number }>();

  if ((target?.rank ?? 0) >= (actor?.rank ?? 0)) {
    throw forbidden('You cannot act on a user at or above your own authority level.');
  }
}
