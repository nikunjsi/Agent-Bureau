import type Database from 'better-sqlite3';
import { nowIso } from '../../../shared/models/ids';
import {
  SettingsValuesSchema,
  USD_MICROS_SETTING_KEYS,
  type SettingKey,
  type SettingsValues,
} from '../../../shared/settings/schema';
import { UsdMicrosSchema } from '../../../shared/models/money';

/**
 * A *stored* row's `value_json` is always already the schema's OUTPUT
 * shape (`setSetting` ran it through `SettingsValuesSchema`'s own
 * transform before writing) — never raw user input again. For most keys
 * the field schema is the identity on its own output, so re-parsing is
 * harmless; for the `usd()` money keys it is NOT (see schema.ts's own
 * comment on `USD_MICROS_SETTING_KEYS` — a real invariant #12 violation
 * found and fixed in M6 session 2), so those go through the
 * already-in-micros validator instead of back through the
 * decimal-accepting one. The transform itself still runs exactly once,
 * at `setSetting`'s write time.
 */
function parseStoredValue<K extends SettingKey>(key: K, storedRaw: unknown): SettingsValues[K] {
  if (USD_MICROS_SETTING_KEYS.has(key)) {
    return UsdMicrosSchema.parse(storedRaw) as SettingsValues[K];
  }
  return SettingsValuesSchema.parse({ [key]: storedRaw } as Partial<SettingsValues>)[key];
}

/** Reads every row from `settings` and parses it through the typed
 * registry schema — the one place a raw `value_json` string becomes a
 * real typed value. */
export function getAllSettings(db: Database.Database): SettingsValues {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as Array<{
    key: string;
    value_json: string;
  }>;
  const raw: Record<string, unknown> = {};
  const storedUsdOverrides: Record<string, number> = {};
  for (const row of rows) {
    const parsedJson: unknown = JSON.parse(row.value_json);
    if (USD_MICROS_SETTING_KEYS.has(row.key)) {
      storedUsdOverrides[row.key] = UsdMicrosSchema.parse(parsedJson);
    } else {
      raw[row.key] = parsedJson;
    }
  }
  // Every non-usd key (present or defaulted) goes through the full schema
  // once, exactly as before; the usd keys' real stored values are spliced
  // in afterward, already correctly parsed — SettingsValuesSchema.parse
  // still supplies their DEFAULT when no row exists for one, since `raw`
  // simply has no entry for it in that case.
  return { ...SettingsValuesSchema.parse(raw), ...storedUsdOverrides } as SettingsValues;
}

export function getSetting<K extends SettingKey>(db: Database.Database, key: K): SettingsValues[K] {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
    { value_json: string } | undefined;
  if (!row) {
    // No stored override — the schema's own default, resolved through the
    // full (transform-bearing, for usd keys) schema exactly once.
    return SettingsValuesSchema.parse({})[key];
  }
  return parseStoredValue(key, JSON.parse(row.value_json));
}

export function setSetting<K extends SettingKey>(
  db: Database.Database,
  key: K,
  value: SettingsValues[K],
): void {
  // Round-trip through the schema so an invalid value is rejected before
  // it ever reaches storage.
  const validated = SettingsValuesSchema.parse({ [key]: value } as Partial<SettingsValues>)[key];
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(validated), nowIso());
}

/**
 * Seeds every given key with its default, `INSERT OR IGNORE` so an
 * existing user override is never clobbered (§28 M1 step 5) — deliberately
 * *not* `setSetting`'s upsert semantics, since this is "fill in whatever
 * is missing", not "the user changed a value". Bulk, one transaction, so a
 * fresh DB either ends up with every key present or none of them.
 */
export function seedSettingDefaults(
  db: Database.Database,
  entries: ReadonlyArray<{ key: string; value: unknown }>,
): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
  );
  const insertAll = db.transaction(() => {
    const insertedAt = nowIso();
    for (const entry of entries) {
      insert.run(entry.key, JSON.stringify(entry.value), insertedAt);
    }
  });
  insertAll();
}
