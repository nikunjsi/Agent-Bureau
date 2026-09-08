import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../src/main/db/settingsLoader';
import { getAllSettings, setSetting } from '../../src/main/db/repositories/settings';
import { SETTINGS_KEYS } from '../../src/shared/settings/schema';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * AUDIT finding #9: settingsLoader.ts ran a raw INSERT OR IGNORE against
 * `settings` itself instead of going through the settings repository — now
 * routed through repositories/settings.ts's seedSettingDefaults(). No
 * behavior change intended; this proves it.
 */
describe('seedSettingsDefaults (AUDIT finding #9)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-settings-seed-'));
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

  it('a fresh database ends up with every registry key present', () => {
    seedSettingsDefaults(db);
    const row = db.prepare('SELECT COUNT(*) as n FROM settings').get() as { n: number };
    expect(row.n).toBe(SETTINGS_KEYS.length);
    // Every key parses cleanly through the typed schema too, not just present as raw JSON.
    expect(() => getAllSettings(db)).not.toThrow();
  });

  it('never clobbers an existing user override — INSERT OR IGNORE semantics, not upsert', () => {
    seedSettingsDefaults(db);
    setSetting(db, 'autonomy.default', 'autonomous');

    seedSettingsDefaults(db); // simulate a second boot

    const settings = getAllSettings(db);
    expect(settings['autonomy.default']).toBe('autonomous');
  });
});
