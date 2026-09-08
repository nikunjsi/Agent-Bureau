import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { getAllSettings, getSetting, setSetting } from '../../../src/main/db/repositories/settings';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * CLAUDE.md invariant #12: "Money is integer micro-dollars everywhere
 * downstream of the config loader." A real, live violation, found and
 * fixed in M6 session 2 while writing item 8's own tests — not part of
 * items 7-9's original scope, but load-bearing for every one of them:
 * `getSetting`/`getAllSettings` were reusing `SettingsValuesSchema` (whose
 * `usd()` fields *transform* decimal dollars → integer micros) to
 * re-deserialize a value that was ALREADY the transform's own output,
 * converting every `budgets.*` money setting a second time on every read
 * that found a real stored row — including the very first real row any
 * fresh database ever gets, from `settingsLoader.ts`'s own first-boot
 * seeding (`budgets.dailyUsd`'s default 20.0 read back as
 * 20_000_000_000_000 micros, not 20_000_000 — a $20 cap silently became a
 * $20,000,000 one). Fixed via `USD_MICROS_SETTING_KEYS` (schema.ts) and
 * `parseStoredValue` (repositories/settings.ts): the decimal→micros
 * transform now runs exactly once, at `setSetting`'s own write time; a
 * stored row is always read back through the already-in-micros validator.
 */
describe('settings money round-trip (§16.1, CLAUDE.md invariant #12)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-settings-money-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a freshly seeded database reads every budgets.* money default back correctly, in micros — the first-boot case', () => {
    seedSettingsDefaults(db);
    expect(getSetting(db, 'budgets.dailyUsd')).toBe(20_000_000);
    expect(getSetting(db, 'budgets.projectUsd')).toBe(50_000_000);
    expect(getSetting(db, 'budgets.perTaskUsd')).toBe(2_000_000);
    expect(getSetting(db, 'budgets.perEmployeeDailyUsd')).toBe(8_000_000);
    expect(getSetting(db, 'budgets.directorReserveUsd')).toBe(2_000_000);
  });

  it('setSetting(decimal) then getSetting reads back the SAME micros value it was set to, not converted a second time', () => {
    setSetting(db, 'budgets.projectUsd', 10.0);
    expect(getSetting(db, 'budgets.projectUsd')).toBe(10_000_000);

    // A second read is stable — not compounding on repeated reads.
    expect(getSetting(db, 'budgets.projectUsd')).toBe(10_000_000);
  });

  it('getAllSettings agrees with getSetting for every usd key, seeded or overridden', () => {
    seedSettingsDefaults(db);
    setSetting(db, 'budgets.perTaskUsd', 3.5);

    const all = getAllSettings(db);
    expect(all['budgets.perTaskUsd']).toBe(3_500_000);
    expect(all['budgets.perTaskUsd']).toBe(getSetting(db, 'budgets.perTaskUsd'));
    expect(all['budgets.dailyUsd']).toBe(getSetting(db, 'budgets.dailyUsd'));
  });

  it('a non-usd setting is unaffected by the fix — still round-trips exactly as before', () => {
    seedSettingsDefaults(db);
    setSetting(db, 'autonomy.default', 'autonomous');
    expect(getSetting(db, 'autonomy.default')).toBe('autonomous');
    expect(getAllSettings(db)['autonomy.default']).toBe('autonomous');
  });

  it('re-seeding after an override never clobbers it (INSERT OR IGNORE) and the override still reads back correctly', () => {
    seedSettingsDefaults(db);
    setSetting(db, 'budgets.dailyUsd', 5.0);
    seedSettingsDefaults(db); // simulate a second boot
    expect(getSetting(db, 'budgets.dailyUsd')).toBe(5_000_000);
  });
});
