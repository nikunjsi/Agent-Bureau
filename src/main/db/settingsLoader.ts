import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  SETTINGS_KEYS,
  SETTINGS_REGISTRY,
  SettingsValuesSchema,
  type SettingKey,
} from '../../shared/settings/schema';
import { seedSettingDefaults } from './repositories/settings';
import { SHIPPING_MODEL_TIERS } from '../engine/modelTiers';

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
      // §7.5: "Shipping defaults are set at build time and MUST be
      // verified against the engine's current model list." Seeding `{}`
      // (what this returned before AUDIT #1) meant the mapping the spec
      // calls for did not exist on a real install at all.
      return SHIPPING_MODEL_TIERS;
    default:
      throw new Error(`dynamicDefaultFor called for a non-dynamic key: ${key}`);
  }
}

/**
 * Inserts every registry default into `settings` on first run (§28 M1 step
 * 5) — via the settings repository's `seedSettingDefaults` (AUDIT finding
 * #9: this file used to run the raw `INSERT OR IGNORE` itself).
 */
export function seedSettingsDefaults(db: Database.Database): void {
  // Parsing {} through the schema yields every *static* default, since
  // every key in SettingsValuesSchema has a `.default(...)`.
  const staticDefaults = SettingsValuesSchema.parse({});

  const entries = SETTINGS_KEYS.map((key) => {
    const meta = SETTINGS_REGISTRY[key];
    return { key, value: meta.dynamicDefault ? dynamicDefaultFor(key) : staticDefaults[key] };
  });
  seedSettingDefaults(db, entries);
}
