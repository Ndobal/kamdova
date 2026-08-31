import { nowIso } from './time';

/**
 * Typed access to platform_settings. Values are stored as TEXT and cast on the
 * way out, so Modules 4-12 can add configuration keys without a migration.
 */
export type SettingValue = string | number | boolean | unknown;

interface SettingRow {
  key: string;
  value: string;
  value_type: 'string' | 'number' | 'boolean' | 'json';
  category: string;
  label: string | null;
  description: string | null;
  is_sensitive: number;
  updated_by: string | null;
  updated_at: string;
}

export function castSetting(row: Pick<SettingRow, 'value' | 'value_type'>): SettingValue {
  switch (row.value_type) {
    case 'number': {
      const n = Number(row.value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'boolean':
      return row.value === 'true' || row.value === '1';
    case 'json':
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    default:
      return row.value;
  }
}

export async function getSetting<T = SettingValue>(
  db: D1Database,
  key: string,
  fallback: T,
): Promise<T> {
  const row = await db
    .prepare(`SELECT value, value_type FROM platform_settings WHERE key = ?`)
    .bind(key)
    .first<Pick<SettingRow, 'value' | 'value_type'>>();
  if (!row) return fallback;
  return castSetting(row) as T;
}

export async function listSettings(db: D1Database, category?: string) {
  const statement = category
    ? db.prepare(`SELECT * FROM platform_settings WHERE category = ? ORDER BY category, key`).bind(category)
    : db.prepare(`SELECT * FROM platform_settings ORDER BY category, key`);
  const { results } = await statement.all<SettingRow>();
  return results.map((row) => ({
    key: row.key,
    value: castSetting(row),
    valueType: row.value_type,
    category: row.category,
    label: row.label,
    description: row.description,
    isSensitive: row.is_sensitive === 1,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }));
}

export async function getSettingRow(db: D1Database, key: string) {
  return await db.prepare(`SELECT * FROM platform_settings WHERE key = ?`).bind(key).first<SettingRow>();
}

/** Serialises `value` according to the key's declared type before storing it. */
export async function writeSetting(
  db: D1Database,
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  const row = await getSettingRow(db, key);
  const valueType = row?.value_type ?? 'string';
  const serialised =
    valueType === 'json' ? JSON.stringify(value)
    : valueType === 'boolean' ? (value ? 'true' : 'false')
    : String(value);

  if (row) {
    await db
      .prepare(`UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = ?`)
      .bind(serialised, updatedBy, nowIso(), key)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO platform_settings (key, value, value_type, category, updated_by, created_at, updated_at)
         VALUES (?, ?, 'string', 'CUSTOM', ?, ?, ?)`,
      )
      .bind(key, serialised, updatedBy, nowIso(), nowIso())
      .run();
  }
}
