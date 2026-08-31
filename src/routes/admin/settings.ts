import { Hono } from 'hono';
import type { App } from '../../types';
import { gateSensitiveAction } from '../../lib/approvals';
import { audit } from '../../lib/audit';
import { notFound, ok, routeParam } from '../../lib/http';
import { requirePermission } from '../../lib/rbac';
import { castSetting, getSettingRow, listSettings, writeSetting } from '../../lib/settings';
import { readJson, Validator } from '../../lib/validate';

export const adminSettingsRoutes = new Hono<App>();

adminSettingsRoutes.get('/', requirePermission('settings.read'), async (c) =>
  ok(c, await listSettings(c.env.DB, c.req.query('category'))),
);

adminSettingsRoutes.get('/:key', requirePermission('settings.read'), async (c) => {
  const row = await getSettingRow(c.env.DB, routeParam(c, 'key'));
  if (!row) throw notFound('Setting');
  return ok(c, {
    key: row.key,
    value: castSetting(row),
    valueType: row.value_type,
    category: row.category,
    label: row.label,
    description: row.description,
    isSensitive: row.is_sensitive === 1,
    updatedAt: row.updated_at,
  });
});

adminSettingsRoutes.put('/:key', requirePermission('settings.manage'), async (c) => {
  const key = routeParam(c, 'key');
  const row = await getSettingRow(c.env.DB, key);
  if (!row) throw notFound('Setting');

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  if (body.value === undefined) v.add('value', 'This field is required.');
  const reason = v.string('reason', { max: 500 });
  v.assert();

  const previous = castSetting(row);

  // Settings flagged sensitive -- currency, pricing splits, who may activate an
  // agreement -- do not change on a deputy's say-so.
  if (row.is_sensitive === 1) {
    const serialised =
      row.value_type === 'json' ? JSON.stringify(body.value)
      : row.value_type === 'boolean' ? (body.value ? 'true' : 'false')
      : String(body.value);

    const gated = await gateSensitiveAction(c, {
      permission: 'settings.manage',
      requestType: 'SETTING_UPDATE',
      entityType: 'platform_setting',
      entityId: key,
      payload: { value: serialised },
      summary: `Change setting ${key}.`,
      reason,
    });
    if (gated) return ok(c, { pendingApproval: true, request: gated }, 202);
  }

  await writeSetting(c.env.DB, key, body.value, c.get('auth').userId);

  await audit(c, {
    action: 'setting.updated',
    entityType: 'platform_setting',
    entityId: key,
    summary: `Changed ${key}.`,
    before: { value: previous },
    after: { value: body.value },
    metadata: { reason },
    severity: row.is_sensitive === 1 ? 'CRITICAL' : 'WARNING',
  });

  const updated = await getSettingRow(c.env.DB, key);
  return ok(c, { key, value: castSetting(updated!) });
});
