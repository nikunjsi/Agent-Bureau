import type Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { nowIso } from '../../shared/models/ids';
import { toJsonColumn } from '../../shared/models/json';
import {
  SETTINGS_KEYS,
  SETTINGS_REGISTRY,
  SettingsValuesSchema,
  type SettingKey,
} from '../../shared/settings/schema';

/**
 * Computes the real default for the handful of settings the static schema
 * can't (§16.1's registry finding #6/#8 in the plan) — kept out of
 * `src/shared` so that module stays free of Node-specific APIs.
 */
function dynamicDefaultFor(key: SettingKey): unknown {
  switch (key) {
    case 'general.homeFolder':
      return path.join(os.homedir(), 'Bureau');
    case 'engines.default':
    case 'engines.oneshotProvider':
      // No engine exists to default to until M3/M13's real detection runs.
      return '';
    case 'engines.modelTiers':
      return {};
    default:
      throw new Error(`dynamicDefaultFor called for a non-dynamic key: ${key}`);
  }
}

/**
 * Inserts every registry default into `settings` on first run (§28 M1 step
 * 5). `INSERT OR IGNORE` so re-running is a no-op — an existing user
 * override is never clobbered, and a fresh DB always ends up with every
 * key present.
 */
export function seedSettingsDefaults(db: Database.Database): void {
  // Parsing {} through the schema yields every *static* default, since
  // every key in SettingsValuesSchema has a `.default(...)`.
  const staticDefaults = SettingsValuesSchema.parse({});

  const insert = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
  );
  const insertAll = db.transaction(() => {
    const insertedAt = nowIso();
    for (const key of SETTINGS_KEYS) {
      const meta = SETTINGS_REGISTRY[key];
      const value = meta.dynamicDefault ? dynamicDefaultFor(key) : staticDefaults[key];
      insert.run(key, toJsonColumn(value), insertedAt);
    }
  });
  insertAll();
}
