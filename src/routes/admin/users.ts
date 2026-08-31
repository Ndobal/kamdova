import { Hono } from 'hono';
import type { App } from '../../types';
import { gateSensitiveAction } from '../../lib/approvals';
import { audit } from '../../lib/audit';
import { hashPassword, newId } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound, ok, paginated, readPagination, routeParam } from '../../lib/http';
import { assertOutranks, requirePermission, SUPER_ADMIN } from '../../lib/rbac';
import { nowIso } from '../../lib/time';
import { readJson, Validator } from '../../lib/validate';

export const adminUserRoutes = new Hono<App>();

const USER_SELECT = `
  SELECT u.id, u.email, u.status, u.email_verified_at AS emailVerifiedAt,
         u.last_login_at AS lastLoginAt, u.created_at AS createdAt, u.updated_at AS updatedAt,
         p.first_name AS firstName, p.last_name AS lastName, p.display_name AS displayName,
         p.phone, p.avatar_url AS avatarUrl,
         (SELECT GROUP_CONCAT(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id) AS roleCodes
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id`;

const shape = (row: Record<string, unknown>) => ({
  ...row,
  roleCodes: undefined,
  roles: row.roleCodes ? String(row.roleCodes).split(',') : [],
});

// -------------------------------------------------------------- listing ----
adminUserRoutes.get('/', requirePermission('users.read'), async (c) => {
  const { page, perPage, offset } = readPagination(c);
  const search = c.req.query('search')?.trim();
  const status = c.req.query('status');
  const role = c.req.query('role');

  const filters: string[] = ['u.deleted_at IS NULL'];
  const params: unknown[] = [];

  if (search) {
    // Bound parameters throughout -- no query fragment is ever built from input.
    filters.push('(u.email LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ? OR p.phone LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (status) {
    filters.push('u.status = ?');
    params.push(status);
  }
  if (role) {
    filters.push('EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = ?)');
    params.push(role);
  }

  const where = `WHERE ${filters.join(' AND ')}`;
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM users u LEFT JOIN profiles p ON p.user_id = u.id ${where}`,
  ).bind(...params).first<{ total: number }>();

  const { results } = await c.env.DB.prepare(
    `${USER_SELECT} ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...params, perPage, offset).all();

  return paginated(c, results.map(shape), { page, perPage, total: countRow?.total ?? 0 });
});

adminUserRoutes.get('/:id', requirePermission('users.read'), async (c) => {
  const id = routeParam(c, 'id');
  const user = await c.env.DB.prepare(`${USER_SELECT} WHERE u.id = ? AND u.deleted_at IS NULL`)
    .bind(id).first();
  if (!user) throw notFound('User');

  const detail = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT r.id, r.code, r.name, ur.granted_at AS grantedAt, ur.expires_at AS expiresAt
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT p.id, p.code, p.name, up.effect, up.granted_at AS grantedAt, up.expires_at AS expiresAt, up.note
         FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = ?`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS active FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    ).bind(id, nowIso()),
  ]);
  const [roles, permissions, sessions] = [detail[0]!, detail[1]!, detail[2]!];

  return ok(c, {
    ...shape(user),
    roles: roles.results,
    directPermissions: permissions.results,
    activeSessions: (sessions.results as { active: number }[])[0]?.active ?? 0,
  });
});

// ------------------------------------------------------------- creation ----
adminUserRoutes.post('/', requirePermission('users.create'), async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const email = v.email('email');
  const password = v.password('password');
  const firstName = v.string('firstName', { required: true, max: 80 });
  const lastName = v.string('lastName', { required: true, max: 80 });
  const phone = v.string('phone', { max: 32 });
  const roleCodes = v.array<string>('roles', { required: true, min: 1 });
  const status = v.enum('status', ['PENDING_VERIFICATION', 'ACTIVE'] as const) ?? 'ACTIVE';
  v.assert();

  // Only a Super Admin can mint another Super Admin. Without this a deputy
  // holding users.create could promote itself by proxy in a single request.
  if (roleCodes!.includes(SUPER_ADMIN) && !auth.isSuperAdmin) {
    throw forbidden('Only a Super Admin can create another Super Admin.');
  }

  const { results: roles } = await c.env.DB.prepare(
    `SELECT id, code, rank FROM roles WHERE code IN (${roleCodes!.map(() => '?').join(',')})`,
  ).bind(...roleCodes!).all<{ id: string; code: string; rank: number }>();

  if (roles.length !== roleCodes!.length) {
    const found = roles.map((r) => r.code);
    throw badRequest('Unknown role.', { unknown: roleCodes!.filter((code) => !found.includes(code)) });
  }

  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  if (existing) throw conflict('An account with that email already exists.');

  const userId = newId();
  const iterations = Number(c.env.PASSWORD_HASH_ITERATIONS) || 100_000;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, status, email_verified_at, password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId, email, await hashPassword(password!, iterations), status,
      status === 'ACTIVE' ? nowIso() : null, nowIso(), nowIso(), nowIso(),
    ),
    c.env.DB.prepare(
      `INSERT INTO profiles (user_id, first_name, last_name, display_name, phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(userId, firstName, lastName, `${firstName} ${lastName}`, phone ?? null, nowIso(), nowIso()),
    ...roles.map((role) =>
      c.env.DB.prepare(
        `INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(newId(), userId, role.id, auth.userId, nowIso()),
    ),
  ]);

  await audit(c, {
    action: 'user.created', entityType: 'user', entityId: userId,
    summary: `Created ${email} with roles ${roleCodes!.join(', ')}.`,
    after: { email, roles: roleCodes, status }, severity: 'NOTICE',
  });

  return ok(c, shape((await c.env.DB.prepare(`${USER_SELECT} WHERE u.id = ?`).bind(userId).first())!), 201);
});

// -------------------------------------------------------------- editing ----
adminUserRoutes.patch('/:id', requirePermission('users.update'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');

  const target = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`)
    .bind(id).first();
  if (!target) throw notFound('User');
  await assertOutranks(c.env.DB, auth, id);

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const fields = {
    first_name: v.string('firstName', { max: 80 }),
    last_name: v.string('lastName', { max: 80 }),
    display_name: v.string('displayName', { max: 160 }),
    phone: v.string('phone', { max: 32 }),
    country: v.string('country', { max: 2 }),
    state: v.string('state', { max: 80 }),
    city: v.string('city', { max: 80 }),
  };
  v.assert();

  const updates = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (updates.length === 0) return ok(c, { updated: false });

  const before = await c.env.DB.prepare(`SELECT * FROM profiles WHERE user_id = ?`).bind(id).first();
  await c.env.DB.prepare(
    `UPDATE profiles SET ${updates.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ? WHERE user_id = ?`,
  ).bind(...updates.map(([, value]) => value), nowIso(), id).run();
  const after = await c.env.DB.prepare(`SELECT * FROM profiles WHERE user_id = ?`).bind(id).first();

  await audit(c, {
    action: 'user.updated', entityType: 'user', entityId: id,
    summary: 'Updated user profile.', before, after,
  });
  return ok(c, { updated: true, profile: after });
});

adminUserRoutes.post('/:id/status', requirePermission('users.suspend'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const status = v.enum('status', ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const, { required: true });
  const reason = v.string('reason', { max: 500 });
  v.assert();

  const target = await c.env.DB.prepare(`SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL`)
    .bind(id).first<{ id: string; status: string }>();
  if (!target) throw notFound('User');
  if (id === auth.userId) throw badRequest('You cannot change your own account status.');
  await assertOutranks(c.env.DB, auth, id);

  const gated = await gateSensitiveAction(c, {
    permission: 'users.suspend',
    requestType: 'USER_STATUS',
    entityType: 'user',
    entityId: id,
    payload: { status, reason },
    summary: `Set user ${id} to ${status}.`,
    reason,
  });
  if (gated) return ok(c, { pendingApproval: true, request: gated }, 202);

  await c.env.DB.prepare(`UPDATE users SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(status, reason ?? null, nowIso(), id).run();

  // Losing ACTIVE must end the sessions too, or a suspended user keeps working
  // until their access token happens to expire.
  if (status !== 'ACTIVE') {
    await c.env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?, revoked_reason = 'status_changed'
        WHERE user_id = ? AND revoked_at IS NULL`,
    ).bind(nowIso(), id).run();
  }

  await audit(c, {
    action: 'user.status_changed', entityType: 'user', entityId: id,
    summary: `Status ${target.status} -> ${status}.`,
    before: { status: target.status }, after: { status, reason }, severity: 'WARNING',
  });
  return ok(c, { id, status });
});

adminUserRoutes.delete('/:id', requirePermission('users.delete'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  if (id === auth.userId) throw badRequest('You cannot delete your own account.');

  const target = await c.env.DB.prepare(`SELECT id, email FROM users WHERE id = ? AND deleted_at IS NULL`)
    .bind(id).first<{ id: string; email: string }>();
  if (!target) throw notFound('User');
  await assertOutranks(c.env.DB, auth, id);

  const gated = await gateSensitiveAction(c, {
    permission: 'users.delete', requestType: 'USER_DELETE', entityType: 'user', entityId: id,
    payload: { email: target.email }, summary: `Delete user ${target.email}.`,
  });
  if (gated) return ok(c, { pendingApproval: true, request: gated }, 202);

  // Soft delete: audit lines and historical records reference this id, and a
  // hard delete would tear holes in the trail.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?`).bind(nowIso(), nowIso(), id),
    c.env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?, revoked_reason = 'user_deleted' WHERE user_id = ? AND revoked_at IS NULL`,
    ).bind(nowIso(), id),
  ]);

  await audit(c, {
    action: 'user.deleted', entityType: 'user', entityId: id,
    summary: `Deleted ${target.email}.`, severity: 'CRITICAL',
  });
  return ok(c, { deleted: true });
});

// ---------------------------------------------------------------- roles ----
adminUserRoutes.post('/:id/roles', requirePermission('roles.assign'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const roleCode = v.string('role', { required: true, max: 40 });
  const expiresAt = v.date('expiresAt');
  v.assert();

  const target = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`)
    .bind(id).first();
  if (!target) throw notFound('User');

  const role = await c.env.DB.prepare(`SELECT id, code, rank FROM roles WHERE code = ?`)
    .bind(roleCode).first<{ id: string; code: string; rank: number }>();
  if (!role) throw badRequest(`Unknown role ${roleCode}.`);

  if (role.code === SUPER_ADMIN && !auth.isSuperAdmin) {
    throw forbidden('Only a Super Admin can grant the Super Admin role.');
  }
  await assertOutranks(c.env.DB, auth, id);

  // A non-Super-Admin must not hand out authority equal to or above their own.
  if (!auth.isSuperAdmin) {
    const actorRank = await c.env.DB.prepare(
      `SELECT COALESCE(MAX(r.rank), 0) AS rank FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
    ).bind(auth.userId).first<{ rank: number }>();
    if (role.rank >= (actorRank?.rank ?? 0)) {
      throw forbidden('You cannot grant a role at or above your own authority level.');
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, role_id) DO UPDATE SET granted_by = excluded.granted_by,
                                                 granted_at = excluded.granted_at,
                                                 expires_at = excluded.expires_at`,
  ).bind(newId(), id, role.id, auth.userId, nowIso(), expiresAt ?? null).run();

  await audit(c, {
    action: 'user.role_granted', entityType: 'user', entityId: id,
    summary: `Granted role ${role.code}.`, after: { role: role.code, expiresAt }, severity: 'WARNING',
  });
  return ok(c, { granted: role.code });
});

adminUserRoutes.delete('/:id/roles/:roleCode', requirePermission('roles.assign'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const roleCode = routeParam(c, 'roleCode');

  const role = await c.env.DB.prepare(`SELECT id, code FROM roles WHERE code = ?`)
    .bind(roleCode).first<{ id: string; code: string }>();
  if (!role) throw notFound('Role');

  if (role.code === SUPER_ADMIN) {
    if (!auth.isSuperAdmin) throw forbidden('Only a Super Admin can revoke the Super Admin role.');
    // Never let the platform end up with nobody who can administer it.
    const remaining = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        JOIN users u ON u.id = ur.user_id
       WHERE r.code = 'SUPER_ADMIN' AND u.deleted_at IS NULL AND ur.user_id <> ?`,
    ).bind(id).first<{ n: number }>();
    if ((remaining?.n ?? 0) === 0) throw conflict('This is the last Super Admin; the role cannot be revoked.');
  }
  await assertOutranks(c.env.DB, auth, id);

  await c.env.DB.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`).bind(id, role.id).run();
  await audit(c, {
    action: 'user.role_revoked', entityType: 'user', entityId: id,
    summary: `Revoked role ${role.code}.`, before: { role: role.code }, severity: 'WARNING',
  });
  return ok(c, { revoked: role.code });
});

// ---------------------------------------- individual permission overrides ----
adminUserRoutes.post('/:id/permissions', requirePermission('permissions.grant'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const code = v.string('permission', { required: true, max: 80 });
  const effect = v.enum('effect', ['GRANT', 'DENY'] as const) ?? 'GRANT';
  const expiresAt = v.date('expiresAt');
  const note = v.string('note', { max: 300 });
  v.assert();

  const target = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`)
    .bind(id).first();
  if (!target) throw notFound('User');

  const permission = await c.env.DB.prepare(`SELECT id, code, is_sensitive FROM permissions WHERE code = ?`)
    .bind(code).first<{ id: string; code: string; is_sensitive: number }>();
  if (!permission) throw badRequest(`Unknown permission ${code}.`);
  await assertOutranks(c.env.DB, auth, id);

  // Nobody can hand out a permission they do not themselves hold.
  if (!auth.isSuperAdmin && effect === 'GRANT' && !auth.permissions.includes(permission.code)) {
    throw forbidden('You cannot grant a permission you do not hold yourself.');
  }

  const gated = await gateSensitiveAction(c, {
    permission: 'permissions.grant',
    requestType: effect === 'GRANT' ? 'PERMISSION_GRANT' : 'PERMISSION_REVOKE',
    entityType: 'user',
    entityId: id,
    payload: { permissionId: permission.id, effect },
    summary: `${effect} ${permission.code} on user ${id}.`,
  });
  if (gated) return ok(c, { pendingApproval: true, request: gated }, 202);

  await c.env.DB.prepare(
    `INSERT INTO user_permissions (id, user_id, permission_id, effect, granted_by, granted_at, expires_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, permission_id) DO UPDATE SET effect = excluded.effect,
                                                       granted_by = excluded.granted_by,
                                                       granted_at = excluded.granted_at,
                                                       expires_at = excluded.expires_at,
                                                       note = excluded.note`,
  ).bind(newId(), id, permission.id, effect, auth.userId, nowIso(), expiresAt ?? null, note ?? null).run();

  await audit(c, {
    action: 'user.permission_set', entityType: 'user', entityId: id,
    summary: `${effect} ${permission.code}.`, after: { permission: permission.code, effect, expiresAt },
    severity: 'WARNING',
  });
  return ok(c, { permission: permission.code, effect });
});

adminUserRoutes.delete('/:id/permissions/:code', requirePermission('permissions.grant'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const code = routeParam(c, 'code');

  const permission = await c.env.DB.prepare(`SELECT id, code FROM permissions WHERE code = ?`)
    .bind(code).first<{ id: string; code: string }>();
  if (!permission) throw notFound('Permission');
  await assertOutranks(c.env.DB, auth, id);

  await c.env.DB.prepare(`DELETE FROM user_permissions WHERE user_id = ? AND permission_id = ?`)
    .bind(id, permission.id).run();

  await audit(c, {
    action: 'user.permission_cleared', entityType: 'user', entityId: id,
    summary: `Removed the individual override for ${permission.code}.`, severity: 'WARNING',
  });
  return ok(c, { cleared: permission.code });
});
