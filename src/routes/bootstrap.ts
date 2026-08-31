import { Hono } from 'hono';
import type { App } from '../types';
import { auditAnonymous } from '../lib/audit';
import { hashPassword, newId } from '../lib/crypto';
import { conflict, forbidden, ok } from '../lib/http';
import { nowIso } from '../lib/time';
import { readJson, Validator } from '../lib/validate';

export const bootstrapRoutes = new Hono<App>();

/**
 * Creates the very first Super Admin.
 *
 * The seed file cannot do this: passwords must be hashed by the Worker, and a
 * password committed to a SQL file in a repository is not a credential, it is a
 * published secret.
 *
 * Zero-trust guard: the endpoint checks for an existing SUPER_ADMIN and refuses
 * once one exists. The check and the insert run against the same D1 session, so
 * the window is small, but the UNIQUE constraint on users.email plus this guard
 * mean the worst case of a race is a duplicate-email conflict, not a second
 * unauthorised admin. Take the route out of index.ts after first run.
 */
bootstrapRoutes.post('/super-admin', async (c) => {
  const existing = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE r.code = 'SUPER_ADMIN'`,
  ).first<{ n: number }>();

  if ((existing?.n ?? 0) > 0) {
    await auditAnonymous(c, {
      action: 'bootstrap.refused',
      summary: 'Bootstrap attempted after a Super Admin already existed.',
      severity: 'CRITICAL',
    });
    throw forbidden('A Super Admin already exists. This endpoint is closed.');
  }

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const email = v.email('email');
  const password = v.password('password');
  const firstName = v.string('firstName', { required: true, max: 80 });
  const lastName = v.string('lastName', { required: true, max: 80 });
  v.assert();

  const taken = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  if (taken) throw conflict('An account with that email already exists.');

  const userId = newId();
  const iterations = Number(c.env.PASSWORD_HASH_ITERATIONS) || 100_000;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, status, email_verified_at,
                          password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
    ).bind(userId, email, await hashPassword(password!, iterations), nowIso(), nowIso(), nowIso(), nowIso()),
    c.env.DB.prepare(
      `INSERT INTO profiles (user_id, first_name, last_name, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(userId, firstName, lastName, `${firstName} ${lastName}`, nowIso(), nowIso()),
    c.env.DB.prepare(
      `INSERT INTO user_roles (id, user_id, role_id, granted_at)
       SELECT ?, ?, id, ? FROM roles WHERE code = 'SUPER_ADMIN'`,
    ).bind(newId(), userId, nowIso()),
  ]);

  await auditAnonymous(c, {
    action: 'bootstrap.super_admin_created',
    entityType: 'user',
    entityId: userId,
    actorId: userId,
    actorEmail: email,
    summary: 'First Super Admin created via bootstrap.',
    severity: 'CRITICAL',
  });

  return ok(c, { id: userId, email, message: 'Super Admin created. Sign in at /api/auth/login.' }, 201);
});
