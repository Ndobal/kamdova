import { sign, verify } from 'hono/jwt';
import type { EnvBindings } from '../types';
import { generateSecretToken, hashToken, newId } from './crypto';
import { nowIso, plusSeconds } from './time';

/**
 * Two different kinds of token, on purpose:
 *
 *  - The ACCESS token is a short-lived JWT. It is self-contained so ordinary
 *    requests need no database round trip to authenticate.
 *  - The REFRESH token is an opaque random string, stored only as a hash. It is
 *    long-lived, so it must be revocable, and revocation means database-backed.
 *
 * Refresh tokens rotate on every use. If a token that has already been rotated
 * is presented again, that is a replay of a stolen token: the entire session
 * family is revoked rather than just the one row.
 */

export interface AccessTokenPayload {
  sub: string;
  email: string;
  sid: string;
  roles: string[];
  perms: string[];
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export async function issueAccessToken(
  env: EnvBindings,
  input: { userId: string; email: string; sessionId: string; roles: string[]; permissions: string[] },
): Promise<{ token: string; expiresIn: number }> {
  const ttl = Number(env.ACCESS_TOKEN_TTL_SECONDS) || 900;
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: AccessTokenPayload = {
    sub: input.userId,
    email: input.email,
    sid: input.sessionId,
    roles: input.roles,
    perms: input.permissions,
    iat: issuedAt,
    exp: issuedAt + ttl,
  };
  return { token: await sign(payload, env.JWT_ACCESS_SECRET, 'HS256'), expiresIn: ttl };
}

export async function verifyAccessToken(
  env: EnvBindings,
  token: string,
): Promise<AccessTokenPayload | null> {
  try {
    return (await verify(token, env.JWT_ACCESS_SECRET, 'HS256')) as unknown as AccessTokenPayload;
  } catch {
    return null;
  }
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

export async function createSession(
  db: D1Database,
  env: EnvBindings,
  input: { userId: string; userAgent?: string | null; ipAddress?: string | null; rotatedFrom?: string | null },
): Promise<IssuedSession> {
  const ttl = Number(env.REFRESH_TOKEN_TTL_SECONDS) || 2_592_000;
  const sessionId = newId();
  const refreshToken = generateSecretToken(48);
  const expiresAt = plusSeconds(ttl);

  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, user_agent, ip_address,
                             expires_at, rotated_from, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      sessionId,
      input.userId,
      await hashToken(refreshToken),
      input.userAgent ?? null,
      input.ipAddress ?? null,
      expiresAt,
      input.rotatedFrom ?? null,
      nowIso(),
      nowIso(),
    )
    .run();

  // The raw token is returned once and never stored; only its hash lives in D1.
  return { sessionId, refreshToken, refreshExpiresAt: expiresAt };
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
  rotated_from: string | null;
}

export async function findSessionByRefreshToken(
  db: D1Database,
  refreshToken: string,
): Promise<SessionRow | null> {
  const hash = await hashToken(refreshToken);
  return await db
    .prepare(
      `SELECT id, user_id, expires_at, revoked_at, rotated_from
       FROM sessions WHERE refresh_token_hash = ?`,
    )
    .bind(hash)
    .first<SessionRow>();
}

export async function revokeSession(db: D1Database, sessionId: string, reason: string) {
  await db
    .prepare(`UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(nowIso(), reason, sessionId)
    .run();
}

export async function revokeAllUserSessions(db: D1Database, userId: string, reason: string) {
  await db
    .prepare(`UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(nowIso(), reason, userId)
    .run();
}

export async function touchSession(db: D1Database, sessionId: string) {
  await db.prepare(`UPDATE sessions SET last_used_at = ? WHERE id = ?`).bind(nowIso(), sessionId).run();
}
