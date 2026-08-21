import type Database from 'better-sqlite3';
import { nowIso } from '../../../shared/models/ids';
import { SettingsValuesSchema, type SettingKey, type SettingsValues } from '../../../shared/settings/schema';

/** Reads every row from `settings` and parses it through the typed
 * registry schema — the one place a raw `value_json` string becomes a
 * real typed value. */
export function getAllSettings(db: Database.Database): SettingsValues {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as Array<{
    key: string;
    value_json: string;
  }>;
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    raw[row.key] = JSON.parse(row.value_json);
  }
  return SettingsValuesSchema.parse(raw);
}

export function getSetting<K extends SettingKey>(db: Database.Database, key: K): SettingsValues[K] {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  const raw: Record<string, unknown> = {};
  if (row) raw[key] = JSON.parse(row.value_json);
  return SettingsValuesSchema.parse(raw)[key];
}

export function setSetting<K extends SettingKey>(db: Database.Database, key: K, value: SettingsValues[K]): void {
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
export function seedSettingDefaults(db: Database.Database, entries: ReadonlyArray<{ key: string; value: unknown }>): void {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)');
  const insertAll = db.transaction(() => {
    const insertedAt = nowIso();
    for (const entry of entries) {
      insert.run(entry.key, JSON.stringify(entry.value), insertedAt);
    }
  });
  insertAll();
}
