import { Hono } from 'hono';
import type { Context } from 'hono';
import type { App, UserRow } from '../types';
import { audit, auditAnonymous, clientIp } from '../lib/audit';
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from '../lib/cookies';
import { generateSecretToken, hashPassword, hashToken, newId, verifyPassword } from '../lib/crypto';
import { badRequest, conflict, ok, tooManyRequests, unauthorized } from '../lib/http';
import { passwordResetEmail, sendEmail, verificationEmail } from '../lib/mailer';
import { requireAuth, resolveAuthContext } from '../lib/rbac';
import { getSetting } from '../lib/settings';
import { isPast, nowIso, plusMinutes } from '../lib/time';
import {
  createSession, findSessionByRefreshToken, issueAccessToken,
  revokeAllUserSessions, revokeSession, touchSession,
} from '../lib/tokens';
import { readJson, Validator } from '../lib/validate';
import {
  LOGIN_LIMIT, REFRESH_LIMIT, REGISTER_LIMIT, RESET_LIMIT,
  rateLimit, reset as resetRateLimit,
} from '../lib/ratelimit';
import { getCookie } from 'hono/cookie';

export const authRoutes = new Hono<App>();

/**
 * Auth responses carry the tokens in the body for the Flutter client (which has
 * no cookie jar and stores them in flutter_secure_storage) AND set httpOnly
 * cookies for a browser dashboard. Each client uses one mechanism and ignores
 * the other.
 */
async function authSuccess(c: Context<App>, user: Pick<UserRow, 'id' | 'email'>) {
  const session = await createSession(c.env.DB, c.env, {
    userId: user.id,
    userAgent: c.req.header('User-Agent'),
    ipAddress: clientIp(c),
  });

  const auth = await resolveAuthContext(c.env.DB, {
    userId: user.id,
    email: user.email,
    sessionId: session.sessionId,
  });

  const access = await issueAccessToken(c.env, {
    userId: user.id,
    email: user.email,
    sessionId: session.sessionId,
    roles: auth.roles,
    permissions: auth.permissions,
  });

  setAuthCookies(c, { accessToken: access.token, refreshToken: session.refreshToken });

  return {
    user: await publicUser(c.env.DB, user.id),
    roles: auth.roles,
    permissions: auth.permissions,
    tokens: {
      tokenType: 'Bearer',
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.refreshExpiresAt,
    },
  };
}

async function publicUser(db: D1Database, userId: string) {
  return await db
    .prepare(
      `SELECT u.id, u.email, u.status, u.email_verified_at AS emailVerifiedAt, u.last_login_at AS lastLoginAt,
              u.created_at AS createdAt,
              p.first_name AS firstName, p.last_name AS lastName, p.display_name AS displayName,
              p.phone, p.avatar_url AS avatarUrl, p.country, p.state, p.city, p.timezone
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.id = ?`,
    )
    .bind(userId)
    .first();
}

// ------------------------------------------------------------- register ----
authRoutes.post('/register', rateLimit(REGISTER_LIMIT, 'email'), async (c) => {
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const email = v.email('email');
  const password = v.password('password');
  const firstName = v.string('firstName', { required: true, max: 80 });
  const lastName = v.string('lastName', { required: true, max: 80 });
  const phone = v.string('phone', { max: 32 });
  const requestedRole = v.string('role', { max: 40 });
  v.assert();

  const allowSelfRegistration = await getSetting(c.env.DB, 'auth.allow_self_registration', true);
  if (!allowSelfRegistration) {
    throw badRequest('Self-registration is currently disabled.');
  }

  // A visitor may only pick from the roles the Super Admin has opened up --
  // never SUPER_ADMIN or PARTNER, whatever the request body claims.
  const openRoles = await getSetting<string[]>(c.env.DB, 'auth.self_registration_roles', ['TEACHER', 'STUDENT']);
  const role = requestedRole ?? 'STUDENT';
  if (!openRoles.includes(role)) {
    throw badRequest(`You cannot register as ${role}.`, { allowed: openRoles });
  }

  const roleRow = await c.env.DB.prepare(`SELECT id FROM roles WHERE code = ?`).bind(role).first<{ id: string }>();
  if (!roleRow) throw badRequest(`Unknown role ${role}.`);

  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  if (existing) throw conflict('An account with that email already exists.');

  const requireVerification = await getSetting(c.env.DB, 'auth.require_email_verification', true);
  const userId = newId();
  const iterations = Number(c.env.PASSWORD_HASH_ITERATIONS) || 100_000;
  const status = requireVerification ? 'PENDING_VERIFICATION' : 'ACTIVE';

  const verificationToken = generateSecretToken();
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, status, password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(userId, email, await hashPassword(password!, iterations), status, nowIso(), nowIso(), nowIso()),
    c.env.DB.prepare(
      `INSERT INTO profiles (user_id, first_name, last_name, display_name, phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(userId, firstName, lastName, `${firstName} ${lastName}`, phone ?? null, nowIso(), nowIso()),
    c.env.DB.prepare(
      `INSERT INTO user_roles (id, user_id, role_id, granted_at) VALUES (?, ?, ?, ?)`,
    ).bind(newId(), userId, roleRow.id, nowIso()),
    c.env.DB.prepare(
      `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at)
       VALUES (?, ?, 'EMAIL_VERIFICATION', ?, ?, ?)`,
    ).bind(newId(), userId, await hashToken(verificationToken), plusMinutes(60 * 24), nowIso()),
  ];
  await c.env.DB.batch(statements);

  const mail = await sendEmail(c.env, { to: email!, ...verificationEmail(verificationToken) });
  await auditAnonymous(c, {
    action: 'auth.register',
    entityType: 'user',
    entityId: userId,
    actorEmail: email,
    summary: `Registered as ${role}.`,
    severity: 'NOTICE',
  });

  if (requireVerification) {
    return ok(
      c,
      {
        user: await publicUser(c.env.DB, userId),
        requiresEmailVerification: true,
        // Development only -- see mailer.ts.
        ...(mail.deliveredInline ? { devVerificationToken: verificationToken } : {}),
      },
      201,
    );
  }
  return ok(c, await authSuccess(c, { id: userId, email: email! }), 201);
});

// ---------------------------------------------------------------- login ----
authRoutes.post('/login', rateLimit(LOGIN_LIMIT, 'email'), async (c) => {
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const email = v.email('email');
  const password = v.string('password', { required: true });
  v.assert();

  const user = await c.env.DB.prepare(
    `SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`,
  ).bind(email).first<UserRow>();

  // Same message whether the address is unknown or the password is wrong, so
  // login cannot be used to discover which emails have accounts.
  const invalid = unauthorized('Email or password is incorrect.');

  if (!user) {
    await auditAnonymous(c, { action: 'auth.login.failed', actorEmail: email, summary: 'No such account.', severity: 'NOTICE' });
    throw invalid;
  }

  if (user.locked_until && !isPast(user.locked_until)) {
    await auditAnonymous(c, {
      action: 'auth.login.blocked', actorId: user.id, actorEmail: email,
      summary: 'Account is temporarily locked.', severity: 'WARNING',
    });
    throw tooManyRequests('Too many failed attempts. Try again later.', { lockedUntil: user.locked_until });
  }

  if (!(await verifyPassword(password!, user.password_hash))) {
    const attempts = user.failed_login_attempts + 1;
    const max = Number(c.env.MAX_FAILED_LOGINS) || 5;
    const lockUntil = attempts >= max ? plusMinutes(Number(c.env.ACCOUNT_LOCK_MINUTES) || 15) : null;

    await c.env.DB.prepare(
      `UPDATE users SET failed_login_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?`,
    ).bind(attempts, lockUntil, nowIso(), user.id).run();

    await auditAnonymous(c, {
      action: 'auth.login.failed', actorId: user.id, actorEmail: email,
      summary: `Wrong password (attempt ${attempts} of ${max}).`,
      severity: lockUntil ? 'WARNING' : 'NOTICE',
    });
    throw invalid;
  }

  if (user.status === 'PENDING_VERIFICATION') {
    throw unauthorized('Verify your email address before signing in.');
  }
  if (user.status !== 'ACTIVE') {
    throw unauthorized(`This account is ${user.status.toLowerCase()}.`);
  }

  await c.env.DB.prepare(
    `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(nowIso(), nowIso(), user.id).run();

  // A genuine sign-in clears the failure streak for this identifier.
  await resetRateLimit(c.env.DB, LOGIN_LIMIT.bucket, `email:${user.email}`);

  const result = await authSuccess(c, user);
  await auditAnonymous(c, {
    action: 'auth.login', actorId: user.id, actorEmail: user.email,
    summary: 'Signed in.', metadata: { roles: result.roles },
  });
  return ok(c, result);
});

// -------------------------------------------------------------- refresh ----
authRoutes.post('/refresh', rateLimit(REFRESH_LIMIT), async (c) => {
  // Flutter posts the token; a browser sends the cookie.
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const presented =
    (typeof body?.refreshToken === 'string' ? body.refreshToken : null) ?? getCookie(c, REFRESH_COOKIE);
  if (!presented) throw unauthorized('No refresh token supplied.');

  const session = await findSessionByRefreshToken(c.env.DB, presented);
  if (!session) throw unauthorized('Refresh token is not recognised.');

  // A token that was already rotated away should never come back. When it does,
  // assume it was stolen and drop every session the user has.
  if (session.revoked_at) {
    await revokeAllUserSessions(c.env.DB, session.user_id, 'refresh_token_reuse');
    await auditAnonymous(c, {
      action: 'auth.refresh.reuse_detected', actorId: session.user_id,
      summary: 'A revoked refresh token was replayed; all sessions revoked.', severity: 'CRITICAL',
    });
    throw unauthorized('Session is no longer valid. Please sign in again.');
  }

  if (isPast(session.expires_at)) {
    await revokeSession(c.env.DB, session.id, 'expired');
    throw unauthorized('Session expired. Please sign in again.');
  }

  const user = await c.env.DB.prepare(
    `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`,
  ).bind(session.user_id).first<UserRow>();
  if (!user || user.status !== 'ACTIVE') throw unauthorized('Account is not active.');

  await revokeSession(c.env.DB, session.id, 'rotated');
  const rotated = await createSession(c.env.DB, c.env, {
    userId: user.id,
    userAgent: c.req.header('User-Agent'),
    ipAddress: clientIp(c),
    rotatedFrom: session.id,
  });

  const auth = await resolveAuthContext(c.env.DB, {
    userId: user.id, email: user.email, sessionId: rotated.sessionId,
  });
  const access = await issueAccessToken(c.env, {
    userId: user.id, email: user.email, sessionId: rotated.sessionId,
    roles: auth.roles, permissions: auth.permissions,
  });

  setAuthCookies(c, { accessToken: access.token, refreshToken: rotated.refreshToken });
  await touchSession(c.env.DB, rotated.sessionId);

  return ok(c, {
    tokens: {
      tokenType: 'Bearer',
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: rotated.refreshToken,
      refreshExpiresAt: rotated.refreshExpiresAt,
    },
    roles: auth.roles,
    permissions: auth.permissions,
  });
});

// --------------------------------------------------------------- logout ----
authRoutes.post('/logout', requireAuth, async (c) => {
  const auth = c.get('auth');
  const all = c.req.query('all') === 'true';
  if (all) await revokeAllUserSessions(c.env.DB, auth.userId, 'user_logout_all');
  else await revokeSession(c.env.DB, auth.sessionId, 'user_logout');

  clearAuthCookies(c);
  await audit(c, { action: all ? 'auth.logout.all' : 'auth.logout', summary: 'Signed out.' });
  return ok(c, { signedOut: true, allDevices: all });
});

// ------------------------------------------------------- verify email ----
authRoutes.post('/verify-email', async (c) => {
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const token = v.string('token', { required: true });
  v.assert();

  const row = await c.env.DB.prepare(
    `SELECT id, user_id, expires_at, consumed_at FROM auth_tokens
      WHERE token_hash = ? AND purpose = 'EMAIL_VERIFICATION'`,
  ).bind(await hashToken(token!)).first<{ id: string; user_id: string; expires_at: string; consumed_at: string | null }>();

  if (!row || row.consumed_at || isPast(row.expires_at)) {
    throw badRequest('This verification link is invalid or has expired.');
  }

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE auth_tokens SET consumed_at = ? WHERE id = ?`).bind(nowIso(), row.id),
    c.env.DB.prepare(
      `UPDATE users SET email_verified_at = ?, status = CASE WHEN status = 'PENDING_VERIFICATION' THEN 'ACTIVE' ELSE status END, updated_at = ?
        WHERE id = ?`,
    ).bind(nowIso(), nowIso(), row.user_id),
  ]);

  const user = await c.env.DB.prepare(`SELECT id, email FROM users WHERE id = ?`).bind(row.user_id).first<UserRow>();
  await auditAnonymous(c, {
    action: 'auth.email_verified', actorId: row.user_id, actorEmail: user?.email,
    summary: 'Email address verified.', severity: 'NOTICE',
  });

  return ok(c, await authSuccess(c, user!));
});

authRoutes.post('/resend-verification', rateLimit(RESET_LIMIT, 'email'), async (c) => {
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const email = v.email('email');
  v.assert();

  const user = await c.env.DB.prepare(
    `SELECT id, email, email_verified_at FROM users WHERE email = ? AND deleted_at IS NULL`,
  ).bind(email).first<UserRow>();

  // Always the same answer, so this cannot enumerate accounts.
  const generic = { message: 'If that account exists and is unverified, a new code has been sent.' };
  if (!user || user.email_verified_at) return ok(c, generic);

  const token = generateSecretToken();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND purpose = 'EMAIL_VERIFICATION' AND consumed_at IS NULL`,
    ).bind(nowIso(), user.id),
    c.env.DB.prepare(
      `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at)
       VALUES (?, ?, 'EMAIL_VERIFICATION', ?, ?, ?)`,
    ).bind(newId(), user.id, await hashToken(token), plusMinutes(60 * 24), nowIso()),
  ]);

  const mail = await sendEmail(c.env, { to: user.email, ...verificationEmail(token) });
  return ok(c, { ...generic, ...(mail.deliveredInline ? { devVerificationToken: token } : {}) });
});

// ------------------------------------------------------ password reset ----
authRoutes.post('/forgot-password', rateLimit(RESET_LIMIT, 'email'), async (c) => {
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const email = v.email('email');
  v.assert();

  const user = await c.env.DB.prepare(
    `SELECT id, email FROM users WHERE email = ? AND deleted_at IS NULL`,
  ).bind(email).first<UserRow>();

  const generic = { message: 'If that account exists, a reset code has been sent.' };
  if (!user) {
    await auditAnonymous(c, { action: 'auth.password_reset.requested', actorEmail: email, summary: 'No such account.' });
    return ok(c, generic);
  }

  const token = generateSecretToken();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND purpose = 'PASSWORD_RESET' AND consumed_at IS NULL`,
    ).bind(nowIso(), user.id),
    c.env.DB.prepare(
      `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at)
       VALUES (?, ?, 'PASSWORD_RESET', ?, ?, ?)`,
    ).bind(newId(), user.id, await hashToken(token), plusMinutes(60), nowIso()),
  ]);

  const mail = await sendEmail(c.env, { to: user.email, ...passwordResetEmail(token) });
  await auditAnonymous(c, {
    action: 'auth.password_reset.requested', actorId: user.id, actorEmail: user.email,
    summary: 'Reset code issued.', severity: 'NOTICE',
  });

  return ok(c, { ...generic, ...(mail.deliveredInline ? { devResetToken: token } : {}) });
});

authRoutes.post('/reset-password', rateLimit(RESET_LIMIT), async (c) => {
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const token = v.string('token', { required: true });
  const password = v.password('password');
  v.assert();

  const row = await c.env.DB.prepare(
    `SELECT id, user_id, expires_at, consumed_at FROM auth_tokens
      WHERE token_hash = ? AND purpose = 'PASSWORD_RESET'`,
  ).bind(await hashToken(token!)).first<{ id: string; user_id: string; expires_at: string; consumed_at: string | null }>();

  if (!row || row.consumed_at || isPast(row.expires_at)) {
    throw badRequest('This reset link is invalid or has expired.');
  }

  const iterations = Number(c.env.PASSWORD_HASH_ITERATIONS) || 100_000;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE auth_tokens SET consumed_at = ? WHERE id = ?`).bind(nowIso(), row.id),
    c.env.DB.prepare(
      `UPDATE users SET password_hash = ?, password_changed_at = ?, failed_login_attempts = 0,
                        locked_until = NULL, updated_at = ? WHERE id = ?`,
    ).bind(await hashPassword(password!, iterations), nowIso(), nowIso(), row.user_id),
  ]);

  // A reset is how an account is recovered after a compromise, so every
  // existing session must die with it.
  await revokeAllUserSessions(c.env.DB, row.user_id, 'password_reset');
  await auditAnonymous(c, {
    action: 'auth.password_reset.completed', actorId: row.user_id,
    summary: 'Password reset; all sessions revoked.', severity: 'WARNING',
  });

  return ok(c, { message: 'Password updated. Please sign in.' });
});

authRoutes.post('/change-password', requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const currentPassword = v.string('currentPassword', { required: true });
  const newPassword = v.password('newPassword');
  v.assert();

  const user = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(auth.userId).first<UserRow>();
  if (!user || !(await verifyPassword(currentPassword!, user.password_hash))) {
    throw unauthorized('Your current password is incorrect.');
  }

  const iterations = Number(c.env.PASSWORD_HASH_ITERATIONS) || 100_000;
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(await hashPassword(newPassword!, iterations), nowIso(), nowIso(), auth.userId).run();

  // Keep the caller signed in on this device; sign them out everywhere else.
  await c.env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?, revoked_reason = 'password_changed'
      WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
  ).bind(nowIso(), auth.userId, auth.sessionId).run();

  await audit(c, { action: 'auth.password_changed', summary: 'Password changed.', severity: 'WARNING' });
  return ok(c, { message: 'Password updated.' });
});
