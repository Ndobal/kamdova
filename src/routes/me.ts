import { Hono } from 'hono';
import type { App } from '../types';
import { audit } from '../lib/audit';
import { buildDashboard } from '../lib/dashboards';
import { ok, routeParam } from '../lib/http';
import { requireAuth } from '../lib/rbac';
import { revokeSession } from '../lib/tokens';
import { nowIso } from '../lib/time';
import { readJson, Validator } from '../lib/validate';
import { notFound } from '../lib/http';

export const meRoutes = new Hono<App>();

// Everything below is the caller acting on their own record. Identity comes
// from the verified session -- never from an id in the path or body.
meRoutes.use('*', requireAuth);

meRoutes.get('/', async (c) => {
  const auth = c.get('auth');
  const user = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.status, u.email_verified_at AS emailVerifiedAt,
            u.last_login_at AS lastLoginAt, u.created_at AS createdAt,
            p.first_name AS firstName, p.last_name AS lastName, p.display_name AS displayName,
            p.phone, p.avatar_url AS avatarUrl, p.gender, p.date_of_birth AS dateOfBirth,
            p.country, p.state, p.city, p.address, p.timezone, p.bio
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = ?`,
  ).bind(auth.userId).first();

  return ok(c, {
    user,
    roles: auth.roles,
    permissions: auth.permissions,
    partnerId: auth.partnerId,
    dashboard: buildDashboard(auth),
  });
});

/** The nav tree for whatever this user is actually allowed to see. */
meRoutes.get('/dashboard', (c) => ok(c, buildDashboard(c.get('auth'))));

meRoutes.patch('/profile', async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);

  const fields = {
    first_name: v.string('firstName', { max: 80 }),
    last_name: v.string('lastName', { max: 80 }),
    display_name: v.string('displayName', { max: 160 }),
    phone: v.string('phone', { max: 32 }),
    avatar_url: v.string('avatarUrl', { max: 512 }),
    gender: v.enum('gender', ['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED'] as const),
    date_of_birth: v.date('dateOfBirth'),
    country: v.string('country', { max: 2 }),
    state: v.string('state', { max: 80 }),
    city: v.string('city', { max: 80 }),
    address: v.string('address', { max: 300 }),
    timezone: v.string('timezone', { max: 64 }),
    bio: v.string('bio', { max: 1000 }),
  };
  v.assert();

  // Note what is absent: email, status and role are not editable here. Changing
  // an email is an identity change and belongs behind verification; status and
  // roles are administrative and belong to the admin routes.
  const updates = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (updates.length === 0) return ok(c, { updated: false });

  const before = await c.env.DB.prepare(`SELECT * FROM profiles WHERE user_id = ?`).bind(auth.userId).first();

  await c.env.DB.prepare(
    `UPDATE profiles SET ${updates.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ?
      WHERE user_id = ?`,
  )
    .bind(...updates.map(([, value]) => value), nowIso(), auth.userId)
    .run();

  const after = await c.env.DB.prepare(`SELECT * FROM profiles WHERE user_id = ?`).bind(auth.userId).first();
  await audit(c, {
    action: 'profile.updated',
    entityType: 'profile',
    entityId: auth.userId,
    summary: 'Updated own profile.',
    before,
    after,
  });

  return ok(c, { updated: true, profile: after });
});

meRoutes.get('/sessions', async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `SELECT id, user_agent AS userAgent, ip_address AS ipAddress, created_at AS createdAt,
            last_used_at AS lastUsedAt, expires_at AS expiresAt
       FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_used_at DESC`,
  ).bind(auth.userId, nowIso()).all();

  return ok(c, results.map((row) => ({ ...row, current: row.id === auth.sessionId })));
});

meRoutes.delete('/sessions/:id', async (c) => {
  const auth = c.get('auth');
  const sessionId = routeParam(c, 'id');

  // Ownership is verified against the session's own user_id, so one user can
  // never revoke another user's session by guessing an id.
  const session = await c.env.DB.prepare(
    `SELECT id FROM sessions WHERE id = ? AND user_id = ?`,
  ).bind(sessionId, auth.userId).first();
  if (!session) throw notFound('Session');

  await revokeSession(c.env.DB, sessionId, 'revoked_by_user');
  await audit(c, {
    action: 'session.revoked',
    entityType: 'session',
    entityId: sessionId,
    summary: 'Revoked one of own sessions.',
    severity: 'NOTICE',
  });

  return ok(c, { revoked: true });
});
