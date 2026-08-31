import type { Context, Next } from 'hono';
import type { App, EnvBindings } from '../types';
import { newId } from './crypto';
import { forbidden } from './http';
import { getSetting } from './settings';
import { nowIso } from './time';

/**
 * Who is allowed to spend an AI generation, and how many they have left.
 *
 * One concept, not two: a trial is a subscription with source = 'TRIAL'. The
 * generation gate therefore consults a single thing, and there is no second
 * code path where a trial rule and a paid rule could drift apart.
 *
 * Quota is snapshotted onto the subscription at purchase, so raising the
 * default weekly cap in the Super Admin dashboard changes what NEW subscribers
 * get without retroactively altering what an existing one already paid for.
 */

export type BillingPeriod = 'ONE_OFF' | 'WEEKLY' | 'MONTHLY' | 'TERMLY';

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_id: string | null;
  source: 'TRIAL' | 'PURCHASE' | 'GRANT';
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'SUSPENDED';
  started_at: string;
  expires_at: string | null;
  quota_limit: number | null;
  quota_period: BillingPeriod | null;
  plan_code?: string | null;
  plan_name?: string | null;
}

export interface Entitlement {
  active: boolean;
  source: 'TRIAL' | 'PURCHASE' | 'GRANT' | null;
  subscriptionId: string | null;
  planCode: string | null;
  planName: string | null;
  expiresAt: string | null;
  /** null = unlimited for the period. */
  quotaLimit: number | null;
  quotaUsed: number;
  quotaRemaining: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  canGenerate: boolean;
  /** Machine-readable reason when canGenerate is false. */
  reason: 'OK' | 'NO_SUBSCRIPTION' | 'EXPIRED' | 'QUOTA_EXHAUSTED' | 'SUSPENDED';
}

/**
 * The usage window a generation counts against.
 *
 * WEEKLY windows are anchored to the subscription's own start date rather than
 * to a calendar week, so someone who subscribes on a Thursday gets a full seven
 * days before the reset -- not a stub period ending on Sunday night.
 */
export function currentPeriod(
  period: BillingPeriod,
  startedAt: string,
  termDays: number,
  at: Date = new Date(),
): { start: string; end: string } {
  const start = new Date(startedAt);
  const now = at.getTime();

  if (period === 'ONE_OFF') {
    // A bundle never resets: one window, open-ended.
    return { start: start.toISOString(), end: new Date(8640000000000000).toISOString() };
  }

  if (period === 'MONTHLY') {
    // Calendar months anchored on the start day-of-month, clamped for short
    // months so a 31st subscription does not skip February.
    const anchorDay = start.getUTCDate();
    const cursor = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const daysInMonth = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
    cursor.setUTCDate(Math.min(anchorDay, daysInMonth));
    if (cursor.getTime() > now) cursor.setUTCMonth(cursor.getUTCMonth() - 1);

    const end = new Date(cursor);
    const nextDays = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 2, 0)).getUTCDate();
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(Math.min(anchorDay, nextDays));
    return { start: cursor.toISOString(), end: end.toISOString() };
  }

  const lengthMs = (period === 'WEEKLY' ? 7 : termDays) * 24 * 60 * 60 * 1000;
  const elapsed = Math.max(0, now - start.getTime());
  const index = Math.floor(elapsed / lengthMs);
  const periodStart = new Date(start.getTime() + index * lengthMs);
  return {
    start: periodStart.toISOString(),
    end: new Date(periodStart.getTime() + lengthMs).toISOString(),
  };
}

/** The live subscription, preferring a paid one over a trial if both exist. */
export async function activeSubscription(db: D1Database, userId: string): Promise<SubscriptionRow | null> {
  return await db
    .prepare(
      `SELECT s.*, p.code AS plan_code, p.name AS plan_name
         FROM subscriptions s
         LEFT JOIN pricing_plans p ON p.id = s.plan_id
        WHERE s.user_id = ?
          AND s.status = 'ACTIVE'
          AND (s.expires_at IS NULL OR s.expires_at > ?)
        ORDER BY CASE s.source WHEN 'PURCHASE' THEN 0 WHEN 'GRANT' THEN 1 ELSE 2 END,
                 s.expires_at DESC
        LIMIT 1`,
    )
    .bind(userId, nowIso())
    .first<SubscriptionRow>();
}

export async function resolveEntitlement(
  db: D1Database,
  env: EnvBindings,
  userId: string,
): Promise<Entitlement> {
  const empty: Entitlement = {
    active: false, source: null, subscriptionId: null, planCode: null, planName: null,
    expiresAt: null, quotaLimit: null, quotaUsed: 0, quotaRemaining: null,
    periodStart: null, periodEnd: null, canGenerate: false, reason: 'NO_SUBSCRIPTION',
  };

  const subscription = await activeSubscription(db, userId);
  if (!subscription) {
    // Distinguish "never had one" from "had one that ran out", so the app can
    // show a renewal prompt rather than a first-time trial offer.
    const lapsed = await db
      .prepare(`SELECT id FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(userId)
      .first();
    return { ...empty, reason: lapsed ? 'EXPIRED' : 'NO_SUBSCRIPTION' };
  }

  const termDays = await getSetting(db, 'billing.term_days', 91);
  const period = subscription.quota_period ?? 'WEEKLY';
  const window = currentPeriod(period, subscription.started_at, Number(termDays) || 91);

  const counter = await db
    .prepare(
      `SELECT used FROM usage_counters
        WHERE user_id = ? AND metric = 'LESSON_GENERATION' AND period_start = ?`,
    )
    .bind(userId, window.start)
    .first<{ used: number }>();

  const used = counter?.used ?? 0;
  const limit = subscription.quota_limit;
  const remaining = limit === null ? null : Math.max(0, limit - used);

  return {
    active: true,
    source: subscription.source,
    subscriptionId: subscription.id,
    planCode: subscription.plan_code ?? null,
    planName: subscription.plan_name ?? (subscription.source === 'TRIAL' ? 'Free trial' : null),
    expiresAt: subscription.expires_at,
    quotaLimit: limit,
    quotaUsed: used,
    quotaRemaining: remaining,
    periodStart: window.start,
    periodEnd: period === 'ONE_OFF' ? null : window.end,
    canGenerate: limit === null || used < limit,
    reason: limit !== null && used >= limit ? 'QUOTA_EXHAUSTED' : 'OK',
  };
}

/**
 * Books one generation against the current window.
 *
 * The UPSERT increments and re-checks the limit in a single statement, and the
 * WHERE clause is what makes it safe: two concurrent requests cannot both read
 * "9 used" and both write "10". The second one's update matches no row and it
 * is refused.
 */
export async function consumeGeneration(
  db: D1Database,
  env: EnvBindings,
  userId: string,
): Promise<Entitlement> {
  const entitlement = await resolveEntitlement(db, env, userId);
  if (!entitlement.canGenerate) return entitlement;
  if (entitlement.quotaLimit === null) return entitlement; // unlimited: nothing to count

  const result = await db
    .prepare(
      `INSERT INTO usage_counters (id, user_id, subscription_id, metric, period_start, period_end,
                                   used, created_at, updated_at)
       VALUES (?, ?, ?, 'LESSON_GENERATION', ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, metric, period_start) DO UPDATE
         SET used = used + 1, updated_at = excluded.updated_at
         WHERE usage_counters.used < ?`,
    )
    .bind(
      newId(), userId, entitlement.subscriptionId,
      entitlement.periodStart, entitlement.periodEnd ?? entitlement.periodStart,
      nowIso(), nowIso(), entitlement.quotaLimit,
    )
    .run();

  if (result.meta.changes === 0) {
    return { ...entitlement, canGenerate: false, reason: 'QUOTA_EXHAUSTED', quotaRemaining: 0 };
  }

  return {
    ...entitlement,
    quotaUsed: entitlement.quotaUsed + 1,
    quotaRemaining: entitlement.quotaLimit - entitlement.quotaUsed - 1,
  };
}

/** Hands a slot back when a generation failed after the slot was taken. */
export async function refundGeneration(db: D1Database, userId: string, periodStart: string) {
  await db
    .prepare(
      `UPDATE usage_counters SET used = MAX(0, used - 1), updated_at = ?
        WHERE user_id = ? AND metric = 'LESSON_GENERATION' AND period_start = ?`,
    )
    .bind(nowIso(), userId, periodStart)
    .run();
}

/**
 * Gate on the generation endpoints.
 *
 * Placed as middleware rather than checked inside the handler so a new
 * generation endpoint cannot be added without one -- the same deny-by-default
 * reasoning the router uses for authentication.
 */
export function requireGenerationAllowance() {
  return async (c: Context<App>, next: Next) => {
    const auth = c.get('auth');

    // A Super Admin is not a customer; billing does not apply to them.
    if (auth.isSuperAdmin) {
      await next();
      return;
    }

    const entitlement = await resolveEntitlement(c.env.DB, c.env, auth.userId);
    if (!entitlement.canGenerate) {
      throw forbidden(messageFor(entitlement), { entitlement });
    }

    c.set('entitlement', entitlement);
    await next();
  };
}

function messageFor(entitlement: Entitlement): string {
  switch (entitlement.reason) {
    case 'QUOTA_EXHAUSTED':
      return `You have used all ${entitlement.quotaLimit} lesson plans for this period. Your allowance resets on ${
        entitlement.periodEnd ? entitlement.periodEnd.slice(0, 10) : 'your next period'
      }.`;
    case 'EXPIRED':
      return 'Your plan has ended. Choose a plan to keep generating lesson notes.';
    case 'SUSPENDED':
      return 'Your subscription is suspended.';
    default:
      return 'Start your free trial or choose a plan to generate lesson notes.';
  }
}
