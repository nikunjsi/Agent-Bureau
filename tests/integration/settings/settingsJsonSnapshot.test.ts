import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { settingsHandlers } from '../../../src/main/ipc/handlers/settings';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * AUDIT M0–M2 #26 — §16.1: "`settings.json` in the data folder is an
 * **export/import** convenience only, written on change for user inspection
 * and never read at runtime." Appendix D lists it among the files a user
 * will find. Nothing wrote it.
 *
 * Driven through the real `settings.set` handler, because the property is
 * "a change through the product writes the file" — a unit test of a
 * snapshot writer would prove the writer and nothing about whether the
 * handler calls it (standing rule 2).
 */
describe('settings.json is written on change and never read (§16.1, AUDIT #26)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;
  let snapshotPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-settingsjson-'));
    const paths = getDbPaths(tmpDir, REAL_MIGRATIONS_DIR);
    db = openConnection(paths.dbPath);
    await runMigrations({
      db,
      dbPath: paths.dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: paths.backupsDir,
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(paths.activityLogPath, db);
    ctx = {
      db,
      activityLog,
      dbPaths: paths,
      pricing: loadPricingYaml(path.resolve('resources/pricing.yaml')),
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
    };
    snapshotPath = path.join(path.dirname(paths.dbPath), 'settings.json');
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a setting changed through the real handler is written to settings.json', async () => {
    expect(existsSync(snapshotPath)).toBe(false);
    const result = await settingsHandlers['set']!(
      { key: 'general.floorPaneWidth', value: 320 },
      ctx,
    );
    expect((result as { ok: boolean }).ok).toBe(true);

    expect(existsSync(snapshotPath), 'settings.json was never written').toBe(true);
    const written = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    expect(written['general.floorPaneWidth']).toBe(320);
    // The whole registry, not just the key that changed — it is a snapshot
    // for a person to read, and a partial file would mislead them.
    expect(Object.keys(written).length).toBeGreaterThan(40);
  });

  it('the snapshot is redacted — a secret-shaped value never reaches a file meant for reading', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123';
    await settingsHandlers['set']!({ key: 'general.homeFolder', value: `C:\\${secret}` }, ctx);
    expect(readFileSync(snapshotPath, 'utf8')).not.toContain(secret);
  });

  it('is written atomically — no temporary file is left beside it', async () => {
    await settingsHandlers['set']!({ key: 'general.sounds', value: true }, ctx);
    const leftovers = readdirSync(path.dirname(snapshotPath)).filter((f) =>
      f.startsWith('settings.json.'),
    );
    expect(leftovers).toEqual([]);
  });

  it('"never read at runtime": nothing in src/ reads settings.json', () => {
    // The half §16.1 cares most about — two authoritative stores would
    // drift. A literal-string scan, deliberately: a reader that builds the
    // filename dynamically would escape it, and would also deserve review.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
      });
    const readers = walk(path.resolve('src'))
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter(
        ({ text }) =>
          /read[A-Za-z]*\([^)]*settings\.json/.test(text) ||
          /SETTINGS_SNAPSHOT_FILE[^;]*read/.test(text),
      )
      .map(({ file }) => path.relative(process.cwd(), file));
    expect(readers).toEqual([]);
  });
});
