import { Hono } from 'hono';
import type { App } from '../types';
import { gateSensitiveAction } from '../lib/approvals';
import { audit, clientIp } from '../lib/audit';
import { newId } from '../lib/crypto';
import { resolveEntitlement } from '../lib/entitlements';
import { badRequest, conflict, notFound, ok, paginated, readPagination, routeParam } from '../lib/http';
import { formatKobo } from '../lib/money';
import { requirePermission, requireSuperAdmin } from '../lib/rbac';
import { getSetting } from '../lib/settings';
import { nowIso, plusSeconds } from '../lib/time';
import { claimTrial, hashDeviceId, hashIp, rememberDevice } from '../lib/trials';
import { readJson, Validator } from '../lib/validate';

// ------------------------------------------------------ KamDova Marketplace ----
export const marketplaceRoutes = new Hono<App>();

const PLAN_SELECT = `
  SELECT p.code, p.name, p.description, p.product_code AS productCode, p.audience,
         p.price_kobo AS priceKobo, p.currency, p.billing_period AS billingPeriod,
         p.lesson_quota AS lessonQuota, p.is_featured AS isFeatured, p.sort_order AS sortOrder,
         pr.name AS productName
    FROM pricing_plans p LEFT JOIN products pr ON pr.code = p.product_code`;

/** The plan catalog a teacher chooses from. */
marketplaceRoutes.get('/plans', async (c) => {
  const audience = c.req.query('audience') ?? 'TEACHER';
  const { results } = await c.env.DB
    .prepare(`${PLAN_SELECT} WHERE p.is_active = 1 AND p.audience = ? ORDER BY p.sort_order, p.price_kobo`)
    .bind(audience)
    .all<{ priceKobo: number; lessonQuota: number | null; billingPeriod: string; isFeatured: number }>();

  return ok(c, results.map((plan) => ({
    ...plan,
    isFeatured: plan.isFeatured === 1,
    priceFormatted: formatKobo(plan.priceKobo),
    // Spelled out so the client does not have to derive it and risk saying
    // something different from what the quota engine actually enforces.
    quotaLabel: plan.lessonQuota === null
      ? 'Unlimited lesson plans'
      : `${plan.lessonQuota} lesson plan${plan.lessonQuota === 1 ? '' : 's'}${
          plan.billingPeriod === 'ONE_OFF' ? '' : ` per ${periodWord(plan.billingPeriod)}`}`,
  })));
});

/**
 * The KamDova capability map, as a tree.
 *
 * Areas (Teacher, Student, Marketplace, Partnership) each carry their
 * features. The client renders whatever comes back, so moving a feature
 * between areas is a row change rather than a client release.
 */
marketplaceRoutes.get('/products', async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT code, name, tagline, description, module, kind, parent_code AS parentCode, icon
         FROM products WHERE is_active = 1 ORDER BY sort_order`,
    )
    .all<{ code: string; kind: string; parentCode: string | null }>();

  const areas = results.filter((row) => row.kind === 'AREA');
  return ok(c, {
    brand: {
      name: await getSetting(c.env.DB, 'platform.name', 'KamDova'),
      tagline: await getSetting(c.env.DB, 'platform.tagline', 'Create. Teach. Learn. Earn.'),
      strapline: await getSetting(c.env.DB, 'platform.strapline', ''),
      partners: await getSetting<string[]>(c.env.DB, 'platform.partners', []),
    },
    areas: areas.map((area) => ({
      ...area,
      features: results.filter((row) => row.parentCode === area.code),
    })),
    // Flat form too, for a client that wants to look one feature up by code.
    all: results,
  });
});

function periodWord(period: string): string {
  switch (period) {
    case 'WEEKLY': return 'week';
    case 'MONTHLY': return 'month';
    case 'TERMLY': return 'term';
    default: return 'period';
  }
}

// ------------------------------------------------------------ own billing ----
export const billingRoutes = new Hono<App>();

/** What the caller is entitled to right now, and how much of it is left. */
billingRoutes.get('/me', requirePermission('billing.self.read'), async (c) => {
  const auth = c.get('auth');
  const entitlement = await resolveEntitlement(c.env.DB, c.env, auth.userId);

  const claimed = await c.env.DB
    .prepare(`SELECT expires_at AS expiresAt, claimed_at AS claimedAt FROM trial_claims WHERE user_id = ?`)
    .bind(auth.userId)
    .first();

  return ok(c, {
    entitlement,
    trial: {
      claimed: !!claimed,
      ...(claimed ?? {}),
      // Only offered when the account has never claimed. The device check runs
      // at claim time -- reporting it here would need the device id, and a
      // "false" would tell a farmer to try a different phone.
      available: !claimed && (await getSetting(c.env.DB, 'trial.enabled', true)),
      days: await getSetting(c.env.DB, 'trial.days', 3),
    },
  });
});

/**
 * Starts the free trial.
 *
 * deviceId is the client-reported hardware identifier (Android SSAID, iOS
 * identifierForVendor). It is HMAC'd before it touches the database and is
 * optional -- a client that will not supply one still gets the account-level
 * rule, which is the guarantee.
 */
billingRoutes.post('/trial', requirePermission('billing.self.purchase'), async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw).catch(() => ({}) as Record<string, unknown>);
  const v = new Validator(body);
  const deviceId = v.string('deviceId', { max: 200 });
  const platform = v.enum('platform', ['ANDROID', 'IOS', 'WEB', 'OTHER'] as const);
  const model = v.string('deviceModel', { max: 120 });
  const appVersion = v.string('appVersion', { max: 40 });
  v.assert();

  const deviceHash = deviceId ? await hashDeviceId(c.env, platform ?? 'OTHER', deviceId) : null;
  const ipHash = await hashIp(c.env, clientIp(c));

  if (deviceHash) {
    await rememberDevice(c.env.DB, {
      userId: auth.userId, deviceHash, platform: platform ?? null,
      model: model ?? null, appVersion: appVersion ?? null,
    });
  }

  const result = await claimTrial(c.env.DB, c.env, {
    userId: auth.userId, deviceHash, platform: platform ?? null, ipHash,
  });

  await audit(c, {
    action: result.granted ? 'trial.granted' : 'trial.refused',
    entityType: 'subscription', entityId: result.subscriptionId ?? auth.userId,
    summary: result.message,
    metadata: { outcome: result.outcome, hasDeviceId: !!deviceHash },
    severity: result.granted ? 'NOTICE' : 'INFO',
  });

  if (!result.granted) throw conflict(result.message, { outcome: result.outcome });

  return ok(c, {
    ...result,
    entitlement: await resolveEntitlement(c.env.DB, c.env, auth.userId),
  }, 201);
});

/**
 * Places an order for a plan.
 *
 * Deliberately does NOT create the subscription. Nothing is granted until the
 * order is marked paid, which is what a payment gateway will do in Module 9 --
 * keeping "how much" separate from "was it collected" separate from "what do
 * they now get", exactly as the architecture note asked.
 */
billingRoutes.post('/orders', requirePermission('billing.self.purchase'), async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const planCode = v.string('planCode', { required: true, max: 40 });
  v.assert();

  const plan = await c.env.DB
    .prepare(`SELECT id, code, name, price_kobo FROM pricing_plans WHERE code = ? AND is_active = 1`)
    .bind(planCode)
    .first<{ id: string; code: string; name: string; price_kobo: number }>();
  if (!plan) throw notFound('Plan');

  const id = newId();
  const reference = `KDV-${Date.now().toString(36).toUpperCase()}-${newId().slice(0, 6).toUpperCase()}`;

  await c.env.DB
    .prepare(
      `INSERT INTO orders (id, reference, user_id, plan_id, amount_kobo, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    )
    .bind(id, reference, auth.userId, plan.id, plan.price_kobo, nowIso(), nowIso())
    .run();

  await audit(c, {
    action: 'order.created', entityType: 'order', entityId: id,
    summary: `Ordered ${plan.name} for ${formatKobo(plan.price_kobo)}.`, severity: 'NOTICE',
  });

  return ok(c, {
    id, reference, planCode: plan.code, planName: plan.name,
    amountKobo: plan.price_kobo, amountFormatted: formatKobo(plan.price_kobo),
    status: 'PENDING',
    note: 'Payment is not yet wired up. An administrator can mark this order paid.',
  }, 201);
});

billingRoutes.get('/orders', requirePermission('billing.self.read'), async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB
    .prepare(
      `SELECT o.id, o.reference, o.amount_kobo AS amountKobo, o.status, o.created_at AS createdAt,
              o.paid_at AS paidAt, p.code AS planCode, p.name AS planName
         FROM orders o JOIN pricing_plans p ON p.id = o.plan_id
        WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 50`,
    )
    .bind(auth.userId)
    .all<{ amountKobo: number }>();

  return ok(c, results.map((row) => ({ ...row, amountFormatted: formatKobo(row.amountKobo) })));
});

// -------------------------------------------------- Super Admin: plans ----
export const adminBillingRoutes = new Hono<App>();

adminBillingRoutes.get('/plans', requirePermission('pricing.manage', 'revenue.read'), async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `${PLAN_SELECT.replace('WHERE p.is_active = 1', '')} ORDER BY p.audience, p.sort_order, p.price_kobo`,
    )
    .all<{ priceKobo: number; isFeatured: number }>();
  return ok(c, results.map((plan) => ({
    ...plan, isFeatured: plan.isFeatured === 1, priceFormatted: formatKobo(plan.priceKobo),
  })));
});

adminBillingRoutes.post('/plans', requirePermission('pricing.manage'), async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const code = v.string('code', { required: true, max: 40 });
  const name = v.string('name', { required: true, max: 120 });
  const description = v.string('description', { max: 400 });
  const productCode = v.string('productCode', { max: 40 });
  const audience = v.enum('audience', ['TEACHER', 'STUDENT'] as const) ?? 'TEACHER';
  const priceKobo = v.integer('priceKobo', { required: true, min: 0 });
  const billingPeriod = v.enum('billingPeriod', ['ONE_OFF', 'WEEKLY', 'MONTHLY', 'TERMLY'] as const, { required: true });
  const lessonQuota = v.integer('lessonQuota', { min: 0, max: 10000 });
  const sortOrder = v.integer('sortOrder', { min: 0, max: 1000 }) ?? 100;
  v.assert();

  const taken = await c.env.DB.prepare(`SELECT id FROM pricing_plans WHERE code = ?`).bind(code).first();
  if (taken) throw conflict(`Plan code ${code} is already in use.`);

  const gated = await gateSensitiveAction(c, {
    permission: 'pricing.manage', requestType: 'SETTING_UPDATE',
    entityType: 'pricing_plan', entityId: code!,
    payload: { value: JSON.stringify(body) }, summary: `Create plan ${code}.`,
  });
  if (gated) return ok(c, { pendingApproval: true, request: gated }, 202);

  const id = newId();
  await c.env.DB
    .prepare(
      `INSERT INTO pricing_plans (id, code, name, description, product_code, audience, price_kobo,
                                  billing_period, lesson_quota, sort_order, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, code, name, description ?? null, productCode ?? null, audience, priceKobo,
          billingPeriod, lessonQuota ?? null, sortOrder, auth.userId, nowIso(), nowIso())
    .run();

  await audit(c, {
    action: 'plan.created', entityType: 'pricing_plan', entityId: id,
    summary: `Created plan ${code} at ${formatKobo(priceKobo!)}.`,
    after: { code, priceKobo, billingPeriod, lessonQuota }, severity: 'CRITICAL',
  });
  return ok(c, { id, code, name }, 201);
});

/** Editing price or quota is the sensitive one: it changes what people are charged. */
adminBillingRoutes.patch('/plans/:code', requirePermission('pricing.manage'), async (c) => {
  const code = routeParam(c, 'code');
  const plan = await c.env.DB.prepare(`SELECT * FROM pricing_plans WHERE code = ?`)
    .bind(code).first<Record<string, unknown>>();
  if (!plan) throw notFound('Plan');

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const fields: Record<string, unknown> = {
    name: v.string('name', { max: 120 }),
    description: v.string('description', { max: 400 }),
    price_kobo: v.integer('priceKobo', { min: 0 }),
    lesson_quota: v.integer('lessonQuota', { min: 0, max: 10000 }),
    billing_period: v.enum('billingPeriod', ['ONE_OFF', 'WEEKLY', 'MONTHLY', 'TERMLY'] as const),
    sort_order: v.integer('sortOrder', { min: 0, max: 1000 }),
  };
  const isActive = v.boolean('isActive');
  const isFeatured = v.boolean('isFeatured');
  v.assert();
  if (isActive !== undefined) fields.is_active = isActive ? 1 : 0;
  if (isFeatured !== undefined) fields.is_featured = isFeatured ? 1 : 0;

  const updates = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (updates.length === 0) return ok(c, { updated: false });

  const gated = await gateSensitiveAction(c, {
    permission: 'pricing.manage', requestType: 'SETTING_UPDATE',
    entityType: 'pricing_plan', entityId: code,
    payload: { value: JSON.stringify(body) }, summary: `Change plan ${code}.`,
  });
  if (gated) return ok(c, { pendingApproval: true, request: gated }, 202);

  await c.env.DB
    .prepare(`UPDATE pricing_plans SET ${updates.map(([col]) => `${col} = ?`).join(', ')}, updated_at = ? WHERE code = ?`)
    .bind(...updates.map(([, value]) => value), nowIso(), code)
    .run();

  await audit(c, {
    action: 'plan.updated', entityType: 'pricing_plan', entityId: String(plan.id),
    summary: `Updated plan ${code}.`, before: plan,
    after: await c.env.DB.prepare(`SELECT * FROM pricing_plans WHERE code = ?`).bind(code).first(),
    severity: 'CRITICAL',
  });

  // Existing subscribers keep the quota snapshotted on their subscription;
  // this only changes what a new purchase gets.
  return ok(c, { code, updated: true, appliesTo: 'new subscriptions only' });
});

// ------------------------------------------- Super Admin: subscriptions ----
adminBillingRoutes.get('/subscriptions', requirePermission('revenue.read', 'payments.read'), async (c) => {
  const { page, perPage, offset } = readPagination(c);
  const status = c.req.query('status');
  const source = c.req.query('source');

  const filters: string[] = [];
  const params: unknown[] = [];
  if (status) { filters.push('s.status = ?'); params.push(status); }
  if (source) { filters.push('s.source = ?'); params.push(source); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM subscriptions s ${where}`)
    .bind(...params).first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.user_id AS userId, u.email, s.source, s.status,
            s.started_at AS startedAt, s.expires_at AS expiresAt,
            s.quota_limit AS quotaLimit, s.quota_period AS quotaPeriod,
            p.code AS planCode, p.name AS planName
       FROM subscriptions s JOIN users u ON u.id = s.user_id
       LEFT JOIN pricing_plans p ON p.id = s.plan_id
       ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...params, perPage, offset).all();

  return paginated(c, results, { page, perPage, total: countRow?.total ?? 0 });
});

/**
 * Marks an order paid and grants the subscription.
 *
 * This is the seam a payment gateway plugs into in Module 9: the gateway will
 * call the same code path on a verified webhook instead of an admin doing it
 * by hand. Super Admin only, because it grants paid access for free.
 */
adminBillingRoutes.post('/orders/:id/mark-paid', requireSuperAdmin, async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');

  const order = await c.env.DB
    .prepare(
      `SELECT o.*, p.code AS plan_code, p.name AS plan_name, p.billing_period, p.lesson_quota
         FROM orders o JOIN pricing_plans p ON p.id = o.plan_id WHERE o.id = ?`,
    )
    .bind(id)
    .first<{
      id: string; user_id: string; plan_id: string; amount_kobo: number; status: string;
      plan_code: string; plan_name: string; billing_period: string; lesson_quota: number | null;
    }>();
  if (!order) throw notFound('Order');
  if (order.status !== 'PENDING') throw conflict(`This order is already ${order.status.toLowerCase()}.`);

  const termDays = Number(await getSetting(c.env.DB, 'billing.term_days', 91)) || 91;
  const lengthDays =
    order.billing_period === 'WEEKLY' ? 7
    : order.billing_period === 'MONTHLY' ? 30
    : order.billing_period === 'TERMLY' ? termDays
    : null; // ONE_OFF bundles do not expire; they are exhausted by use.

  const subscriptionId = newId();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, plan_id, source, status, started_at, expires_at,
                                  quota_limit, quota_period, price_paid_kobo, created_at, updated_at)
       VALUES (?, ?, ?, 'PURCHASE', 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      subscriptionId, order.user_id, order.plan_id, nowIso(),
      lengthDays === null ? null : plusSeconds(lengthDays * 24 * 60 * 60),
      order.lesson_quota, order.billing_period, order.amount_kobo, nowIso(), nowIso(),
    ),
    c.env.DB.prepare(
      `UPDATE orders SET status = 'PAID', paid_at = ?, subscription_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), subscriptionId, nowIso(), id),
  ]);

  await audit(c, {
    action: 'order.marked_paid', entityType: 'order', entityId: id,
    summary: `Marked ${order.plan_name} paid and granted the subscription.`,
    metadata: { subscriptionId, amountKobo: order.amount_kobo }, severity: 'CRITICAL',
  });

  return ok(c, { orderId: id, subscriptionId, status: 'PAID' });
});

/** Hand someone access without payment -- for support, pilots and schools. */
adminBillingRoutes.post('/subscriptions/grant', requireSuperAdmin, async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const userId = v.string('userId', { required: true, max: 64 });
  const days = v.integer('days', { required: true, min: 1, max: 3650 });
  const quota = v.integer('lessonQuota', { min: 0, max: 10000 });
  const period = v.enum('quotaPeriod', ['ONE_OFF', 'WEEKLY', 'MONTHLY', 'TERMLY'] as const) ?? 'WEEKLY';
  const reason = v.string('reason', { required: true, max: 300 });
  v.assert();

  const user = await c.env.DB.prepare(`SELECT id, email FROM users WHERE id = ? AND deleted_at IS NULL`)
    .bind(userId).first<{ id: string; email: string }>();
  if (!user) throw badRequest('That user does not exist.');

  const id = newId();
  await c.env.DB
    .prepare(
      `INSERT INTO subscriptions (id, user_id, source, status, started_at, expires_at,
                                  quota_limit, quota_period, granted_by, grant_reason, created_at, updated_at)
       VALUES (?, ?, 'GRANT', 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, nowIso(), plusSeconds(days! * 24 * 60 * 60), quota ?? null, period,
          auth.userId, reason, nowIso(), nowIso())
    .run();

  await audit(c, {
    action: 'subscription.granted', entityType: 'subscription', entityId: id,
    summary: `Granted ${days} days to ${user.email}: ${reason}`,
    metadata: { quota, period }, severity: 'CRITICAL',
  });
  return ok(c, { id, userId, days, expiresAt: plusSeconds(days! * 24 * 60 * 60) }, 201);
});

/** Trial-farming signal: refusals grouped by outcome. */
adminBillingRoutes.get('/trial-attempts', requirePermission('reports.read'), async (c) => {
  const since = c.req.query('since') ?? plusSeconds(-30 * 24 * 60 * 60);
  const { results } = await c.env.DB
    .prepare(
      `SELECT outcome, COUNT(*) AS attempts, COUNT(DISTINCT device_hash) AS devices
         FROM trial_attempts WHERE created_at >= ? GROUP BY outcome ORDER BY attempts DESC`,
    )
    .bind(since)
    .all();
  return ok(c, { since, breakdown: results });
});
