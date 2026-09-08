import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { scaffoldPack, PackAlreadyExistsError } from '../../../src/main/packs/scaffoldPack';
import { loadPack } from '../../../src/main/packs/loadPack';
import { validatePack } from '../../../src/main/packs/validatePack';
import { installPack } from '../../../src/main/packs/installPack';
import { getRoleByFullKey } from '../../../src/main/db/repositories/roles';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const APP_VERSION = '0.0.1';

/**
 * §6.6's claim: scaffold "generates a **valid** skeleton so a user can
 * author their own from day one. This is how the product covers
 * 'everything' without lying about it."
 *
 * The whole test is whether "valid" is true. Nothing here inspects the
 * generated YAML by hand — it runs the real validator and the real
 * installer over the real output, because a skeleton the author has to fix
 * before it validates is worse than none: they cannot tell their mistakes
 * from the generator's.
 */
describe('scaffoldPack (§6.6)', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-scaffold-'));
    baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces a pack that passes all eight checks with no errors and no warnings', () => {
    const scaffolded = scaffoldPack({ baseDir, key: 'marketing', appVersion: APP_VERSION });

    const loaded = loadPack(scaffolded.rootDir);
    expect(loaded.errors).toEqual([]);

    const result = validatePack(loaded.pack!, { appVersion: APP_VERSION });
    expect(result.errors).toEqual([]);
    // Warnings too. A skeleton that immediately warns teaches the author
    // that warnings are normal, which is the opposite of what they need.
    expect(result.warnings).toEqual([]);
  });

  it('produces a pack that actually installs', () => {
    const scaffolded = scaffoldPack({ baseDir, key: 'marketing', appVersion: APP_VERSION });

    const result = installPack({
      db,
      activityLog,
      baseDir,
      sourceDir: scaffolded.rootDir,
      origin: 'user',
      appVersion: APP_VERSION,
    });

    expect(result.errors).toEqual([]);
    expect(result.installed).toBe(true);
    expect(getRoleByFullKey(db, 'marketing:specialist')).not.toBeNull();
  });

  it('declares the running app version, so the skeleton is never too new for itself', () => {
    // §6.3's own example declares 1.0.0 while the app is 0.0.1 — taken
    // literally, it fails check 1. The scaffold must not repeat that.
    const scaffolded = scaffoldPack({ baseDir, key: 'marketing', appVersion: APP_VERSION });
    const manifest = readFileSync(path.join(scaffolded.rootDir, 'pack.yaml'), 'utf8');
    expect(manifest).toContain(`bureau_min_version: ${APP_VERSION}`);
  });

  it('writes real prompt content, not an empty placeholder file', () => {
    // Check 3 rejects an empty or whitespace-only prompt, so a scaffold
    // that wrote `TODO` alone would fail its own validator.
    const scaffolded = scaffoldPack({ baseDir, key: 'marketing', appVersion: APP_VERSION });
    const prompt = readFileSync(path.join(scaffolded.rootDir, 'prompts', 'specialist.md'), 'utf8');
    expect(prompt.trim().length).toBeGreaterThan(200);
  });

  it('ships a README that explains adding a role and the two easy-to-miss rules', () => {
    const scaffolded = scaffoldPack({ baseDir, key: 'marketing', appVersion: APP_VERSION });
    const readme = readFileSync(path.join(scaffolded.rootDir, 'README.md'), 'utf8');
    expect(readme).toContain('network_allow');
    expect(readme).toContain('Adding a role');
  });

  it('refuses to overwrite an existing pack', () => {
    scaffoldPack({ baseDir, key: 'marketing', appVersion: APP_VERSION });
    expect(() => scaffoldPack({ baseDir, key: 'marketing', appVersion: APP_VERSION })).toThrow(
      PackAlreadyExistsError,
    );
  });

  it('rejects a key that would not survive the manifest schema', () => {
    for (const bad of ['Marketing', 'my pack', '', '-leading', 'trailing/slash']) {
      expect(() => scaffoldPack({ baseDir, key: bad, appVersion: APP_VERSION }), bad).toThrow();
    }
  });

  it('seeds its own conventions note when installed', () => {
    const scaffolded = scaffoldPack({ baseDir, key: 'marketing', appVersion: APP_VERSION });
    const result = installPack({
      db,
      activityLog,
      baseDir,
      sourceDir: scaffolded.rootDir,
      origin: 'user',
      appVersion: APP_VERSION,
    });
    expect(result.memorySeeded).toBe(1);
  });
});
