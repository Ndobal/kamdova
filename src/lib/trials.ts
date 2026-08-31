import type { EnvBindings } from '../types';
import { newId } from './crypto';
import { getSetting } from './settings';
import { nowIso, plusSeconds } from './time';
import { activeSubscription } from './entitlements';

/**
 * The free trial, and the one-trial rule.
 *
 * Two layers, with honestly different strengths:
 *
 *   1. ACCOUNT -- a UNIQUE constraint on trial_claims.user_id. This is a real
 *      guarantee. No client can get around it.
 *
 *   2. DEVICE -- a UNIQUE constraint on trial_claims.device_hash. This is a
 *      deterrent, not a guarantee, and it is important not to oversell it:
 *      the identifier is reported by the app, so a rooted phone, a modified
 *      build or an emulator can send a fresh one. Android's SSAID survives an
 *      app reinstall but not a factory reset; iOS identifierForVendor does not
 *      even survive a reinstall. It stops the casual second account on the same
 *      phone, which is most of the abuse, and nothing more.
 *
 * The raw device id is never stored. It is HMAC'd under a server secret, so a
 * database leak yields no identifiers that could be correlated with a device
 * elsewhere, and an attacker who guesses a device id cannot look it up.
 */

export type TrialOutcome =
  | 'GRANTED'
  | 'ACCOUNT_ALREADY_CLAIMED'
  | 'DEVICE_ALREADY_CLAIMED'
  | 'TRIALS_DISABLED'
  | 'ALREADY_SUBSCRIBED';

export interface TrialResult {
  outcome: TrialOutcome;
  granted: boolean;
  expiresAt?: string;
  subscriptionId?: string;
  message: string;
}

/** Keyed HMAC, not a bare hash: an unkeyed digest of a device id is trivially rainbow-tabled. */
export async function hashDeviceId(env: EnvBindings, platform: string, deviceId: string): Promise<string> {
  const secret = env.DEVICE_HASH_SECRET || env.JWT_REFRESH_SECRET;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${platform.toUpperCase()}:${deviceId}`),
  );
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashIp(env: EnvBindings, ip: string | null): Promise<string | null> {
  if (!ip) return null;
  return await hashDeviceId(env, 'IP', ip);
}

async function record(
  db: D1Database,
  outcome: TrialOutcome,
  userId: string,
  deviceHash: string | null,
  ipHash: string | null,
) {
  // Refusals are recorded too: a spike of DEVICE_ALREADY_CLAIMED is the only
  // way to see that someone is farming trials.
  await db
    .prepare(
      `INSERT INTO trial_attempts (id, user_id, device_hash, ip_hash, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId(), userId, deviceHash, ipHash, outcome, nowIso())
    .run()
    .catch((error) => console.error('trial attempt log failed', error));
}

export async function claimTrial(
  db: D1Database,
  env: EnvBindings,
  input: { userId: string; deviceHash: string | null; platform: string | null; ipHash: string | null },
): Promise<TrialResult> {
  const { userId, deviceHash, platform, ipHash } = input;

  const enabled = await getSetting(db, 'trial.enabled', true);
  if (!enabled) {
    await record(db, 'TRIALS_DISABLED', userId, deviceHash, ipHash);
    return { outcome: 'TRIALS_DISABLED', granted: false, message: 'Free trials are not available at the moment.' };
  }

  // Already paying? Granting a trial on top would shorten nothing and confuse
  // the entitlement lookup, which prefers the paid subscription anyway.
  if (await activeSubscription(db, userId)) {
    await record(db, 'ALREADY_SUBSCRIBED', userId, deviceHash, ipHash);
    return { outcome: 'ALREADY_SUBSCRIBED', granted: false, message: 'You already have an active plan.' };
  }

  const existing = await db
    .prepare(`SELECT id, expires_at FROM trial_claims WHERE user_id = ?`)
    .bind(userId)
    .first<{ id: string; expires_at: string }>();
  if (existing) {
    await record(db, 'ACCOUNT_ALREADY_CLAIMED', userId, deviceHash, ipHash);
    return {
      outcome: 'ACCOUNT_ALREADY_CLAIMED', granted: false,
      message: 'This account has already used its free trial.',
    };
  }

  if (deviceHash) {
    const onDevice = await db
      .prepare(`SELECT user_id FROM trial_claims WHERE device_hash = ?`)
      .bind(deviceHash)
      .first<{ user_id: string }>();
    if (onDevice) {
      await record(db, 'DEVICE_ALREADY_CLAIMED', userId, deviceHash, ipHash);
      return {
        outcome: 'DEVICE_ALREADY_CLAIMED', granted: false,
        // Deliberately does not say WHICH account used it -- that would leak
        // one user's activity to another.
        message: 'A free trial has already been used on this device.',
      };
    }
  }

  const days = Number(await getSetting(db, 'trial.days', 3)) || 3;
  const quota = Number(await getSetting(db, 'trial.lesson_quota', 5)) || 5;
  const expiresAt = plusSeconds(days * 24 * 60 * 60);

  const subscriptionId = newId();
  const claimId = newId();

  try {
    await db.batch([
      db.prepare(
        `INSERT INTO subscriptions (id, user_id, source, status, started_at, expires_at,
                                    quota_limit, quota_period, created_at, updated_at)
         VALUES (?, ?, 'TRIAL', 'ACTIVE', ?, ?, ?, 'ONE_OFF', ?, ?)`,
      ).bind(subscriptionId, userId, nowIso(), expiresAt, quota, nowIso(), nowIso()),
      db.prepare(
        `INSERT INTO trial_claims (id, user_id, device_hash, platform, ip_hash,
                                   subscription_id, claimed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(claimId, userId, deviceHash, platform, ipHash, subscriptionId, nowIso(), expiresAt),
    ]);
  } catch (error) {
    // The UNIQUE constraints are the real enforcement -- the SELECTs above are
    // a fast path, and two simultaneous claims would both pass them. Losing
    // that race lands here, which is the correct outcome, not an error.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      await record(db, deviceHash ? 'DEVICE_ALREADY_CLAIMED' : 'ACCOUNT_ALREADY_CLAIMED', userId, deviceHash, ipHash);
      return {
        outcome: deviceHash ? 'DEVICE_ALREADY_CLAIMED' : 'ACCOUNT_ALREADY_CLAIMED',
        granted: false,
        message: 'A free trial has already been used here.',
      };
    }
    throw error;
  }

  await record(db, 'GRANTED', userId, deviceHash, ipHash);
  return {
    outcome: 'GRANTED', granted: true, expiresAt, subscriptionId,
    message: `Your ${days}-day free trial has started. It includes ${quota} lesson plans.`,
  };
}

/** Records the device against the user on sign-in, whether or not a trial is involved. */
export async function rememberDevice(
  db: D1Database,
  input: { userId: string; deviceHash: string; platform: string | null; model: string | null; appVersion: string | null },
) {
  await db
    .prepare(
      `INSERT INTO devices (id, device_hash, user_id, platform, model, app_version, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_hash, user_id) DO UPDATE
         SET last_seen_at = excluded.last_seen_at,
             model = COALESCE(excluded.model, devices.model),
             app_version = COALESCE(excluded.app_version, devices.app_version)`,
    )
    .bind(newId(), input.deviceHash, input.userId, input.platform, input.model, input.appVersion, nowIso(), nowIso())
    .run();
}

/**
 * Moves lapsed subscriptions to EXPIRED.
 *
 * The entitlement lookup already filters on expires_at, so access is correct
 * without this -- it exists so the admin dashboard and any future reporting see
 * a truthful status rather than a pile of ACTIVE rows that expired months ago.
 */
export async function expireLapsedSubscriptions(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE subscriptions SET status = 'EXPIRED', updated_at = ?
        WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .bind(nowIso(), nowIso())
    .run();
  return result.meta.changes ?? 0;
}
