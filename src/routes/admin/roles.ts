import { Hono } from 'hono';
import type { App } from '../../types';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound, ok, routeParam } from '../../lib/http';
import { requirePermission, SUPER_ADMIN } from '../../lib/rbac';
import { nowIso } from '../../lib/time';
import { readJson, Validator } from '../../lib/validate';

export const adminRoleRoutes = new Hono<App>();

adminRoleRoutes.get('/', requirePermission('roles.read'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.code, r.name, r.description, r.rank, r.is_system AS isSystem,
            (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS userCount,
            (SELECT GROUP_CONCAT(p.code) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
              WHERE rp.role_id = r.id) AS permissionCodes
       FROM roles r ORDER BY r.rank DESC`,
  ).all();

  return ok(
    c,
    results.map((row) => ({
      ...row,
      isSystem: row.isSystem === 1,
      permissionCodes: undefined,
      permissions: row.permissionCodes ? String(row.permissionCodes).split(',').sort() : [],
    })),
  );
});

/** The full catalog, grouped for the admin UI permission grid. */
adminRoleRoutes.get('/permissions', requirePermission('roles.read', 'permissions.grant'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, code, name, description, category, is_sensitive AS isSensitive
       FROM permissions ORDER BY category, code`,
  ).all<{ id: string; code: string; name: string; description: string; category: string; isSensitive: number }>();

  const byCategory = new Map<string, unknown[]>();
  for (const row of results) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category)!.push({ ...row, isSensitive: row.isSensitive === 1 });
  }

  return ok(c, {
    total: results.length,
    categories: [...byCategory.entries()].map(([category, permissions]) => ({ category, permissions })),
  });
});

adminRoleRoutes.put('/:code/permissions', requirePermission('roles.manage'), async (c) => {
  const auth = c.get('auth');
  const code = routeParam(c, 'code');

  // roles.manage is sensitive, so in practice only a Super Admin reaches here;
  // this is the explicit belt to that braces.
  if (!auth.isSuperAdmin) throw badRequest('Only a Super Admin can change a role definition.');

  const role = await c.env.DB.prepare(`SELECT id, code FROM roles WHERE code = ?`)
    .bind(code).first<{ id: string; code: string }>();
  if (!role) throw notFound('Role');
  if (role.code === SUPER_ADMIN) {
    throw conflict('The Super Admin role always holds every permission and cannot be edited.');
  }

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const permissionCodes = v.array<string>('permissions', { required: true });
  v.assert();

  const { results: permissions } = permissionCodes!.length
    ? await c.env.DB.prepare(
        `SELECT id, code FROM permissions WHERE code IN (${permissionCodes!.map(() => '?').join(',')})`,
      ).bind(...permissionCodes!).all<{ id: string; code: string }>()
    : { results: [] as { id: string; code: string }[] };

  if (permissions.length !== permissionCodes!.length) {
    const found = permissions.map((p) => p.code);
    throw badRequest('Unknown permission.', { unknown: permissionCodes!.filter((p) => !found.includes(p)) });
  }

  const before = await c.env.DB.prepare(
    `SELECT GROUP_CONCAT(p.code) AS codes FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
  ).bind(role.id).first<{ codes: string | null }>();

  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM role_permissions WHERE role_id = ?`).bind(role.id),
    ...permissions.map((permission) =>
      c.env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?)`,
      ).bind(role.id, permission.id, nowIso()),
    ),
  ]);

  await audit(c, {
    action: 'role.permissions_set', entityType: 'role', entityId: role.id,
    summary: `Set ${permissions.length} permission(s) on ${role.code}.`,
    before: { permissions: before?.codes?.split(',') ?? [] },
    after: { permissions: permissionCodes },
    severity: 'CRITICAL',
  });

  return ok(c, { role: role.code, permissions: permissionCodes });
});
