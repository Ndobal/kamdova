import type { Context, Next } from 'hono';
import type { App } from '../types';
import { clientIp } from './audit';
import { tooManyRequests } from './http';
import { nowIso, plusSeconds } from './time';

/**
 * D1-backed fixed-window rate limiting.
 *
 * Credential endpoints are limited on BOTH the client IP and the submitted
 * identifier. IP alone lets a botnet spread an attack on one account across
 * many addresses; identifier alone lets one address grind through an account
 * list. Tripping either limit is enough to reject.
 *
 * This is not a distributed-systems-grade limiter -- two isolates can race on
 * the same window and slightly overshoot. That is an acceptable trade for the
 * foundation; if it needs to be exact later, move the counter to a Durable
 * Object, which serialises writes per key by construction.
 */
export interface RateLimitRule {
  bucket: string;
  limit: number;
  windowSeconds: number;
}

export async function consume(
  db: D1Database,
  rule: RateLimitRule,
  subject: string,
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const key = `${rule.bucket}:${subject}`;
  const now = new Date();

  const row = await db
    .prepare(`SELECT count, window_started_at, expires_at FROM rate_limits WHERE key = ?`)
    .bind(key)
    .first<{ count: number; window_started_at: string; expires_at: string }>();

  const windowExpired = !row || new Date(row.expires_at).getTime() <= now.getTime();

  if (windowExpired) {
    const expiresAt = plusSeconds(rule.windowSeconds, now);
    await db
      .prepare(
        `INSERT INTO rate_limits (key, count, window_started_at, expires_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET count = 1, window_started_at = excluded.window_started_at,
                                        expires_at = excluded.expires_at`,
      )
      .bind(key, nowIso(), expiresAt)
      .run();
    return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
  }

  const next = row.count + 1;
  const retryAfter = Math.max(1, Math.ceil((new Date(row.expires_at).getTime() - now.getTime()) / 1000));

  if (next > rule.limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
  }

  await db.prepare(`UPDATE rate_limits SET count = ? WHERE key = ?`).bind(next, key).run();
  return { allowed: true, remaining: rule.limit - next, retryAfterSeconds: retryAfter };
}

/** Clears the counter after a legitimate success, so one good login resets the streak. */
export async function reset(db: D1Database, bucket: string, subject: string): Promise<void> {
  await db.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(`${bucket}:${subject}`).run();
}

/**
 * Middleware form. `subjectFrom` pulls the second dimension out of the request
 * body (usually the email) without consuming the stream the handler needs, by
 * reading a clone.
 */
export function rateLimit(rule: RateLimitRule, subjectField?: string) {
  return async (c: Context<App>, next: Next) => {
    const ip = clientIp(c) ?? 'unknown';
    const subjects = [`ip:${ip}`];

    if (subjectField) {
      try {
        const body = (await c.req.raw.clone().json()) as Record<string, unknown>;
        const value = body?.[subjectField];
        if (typeof value === 'string' && value) subjects.push(`${subjectField}:${value.toLowerCase()}`);
      } catch {
        // Unparseable body: the IP dimension still applies.
      }
    }

    for (const subject of subjects) {
      const result = await consume(c.env.DB, rule, subject);
      if (!result.allowed) {
        c.header('Retry-After', String(result.retryAfterSeconds));
        throw tooManyRequests('Too many requests. Please slow down.', {
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
    }

    await next();
  };
}

export const LOGIN_LIMIT: RateLimitRule = { bucket: 'auth.login', limit: 10, windowSeconds: 300 };
export const REGISTER_LIMIT: RateLimitRule = { bucket: 'auth.register', limit: 5, windowSeconds: 3600 };
export const RESET_LIMIT: RateLimitRule = { bucket: 'auth.reset', limit: 5, windowSeconds: 3600 };
export const REFRESH_LIMIT: RateLimitRule = { bucket: 'auth.refresh', limit: 60, windowSeconds: 300 };
