import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { scaffoldPack } from '../../../src/main/packs/scaffoldPack';
import { installPack } from '../../../src/main/packs/installPack';
import {
  isPackAvailable,
  revalidateInstalledPacks,
} from '../../../src/main/packs/revalidateInstalledPacks';
import { getPackByKey } from '../../../src/main/db/repositories/packs';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const APP_VERSION = '0.0.1';

/**
 * X-4 / §6.7 L989: install validates a pack against the departments other
 * installed packs already provide (`installedDepartmentKeys`), and startup
 * revalidation did not pass them. So a role whose department lives in another
 * pack installed cleanly and was marked `failed` on the next boot — a pack
 * that worked yesterday withheld from hiring today, with no user action.
 */
describe('startup revalidation knows about other packs’ departments (X-4)', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-xpack-'));
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
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function install(key: string, sourceDir: string): void {
    const result = installPack({
      db,
      activityLog,
      baseDir,
      sourceDir,
      origin: 'user',
      appVersion: APP_VERSION,
    });
    if (!result.installed) throw new Error(`${key} did not install: ${result.errors.join('; ')}`);
  }

  it('a role whose department comes from another pack survives a restart', () => {
    // Pack one provides the department; pack two has a role in it and no
    // departments of its own.
    const provider = scaffoldPack({ baseDir: tmpDir, key: 'alpha', appVersion: APP_VERSION });
    const consumer = scaffoldPack({ baseDir: tmpDir, key: 'beta', appVersion: APP_VERSION });
    // beta keeps its own department (a pack must define one) and gains a
    // second role whose department belongs to alpha — the cross-pack case.
    const specialist = readFileSync(
      path.join(consumer.rootDir, 'roles', 'specialist.yaml'),
      'utf8',
    );
    writeFileSync(
      path.join(consumer.rootDir, 'roles', 'visitor.yaml'),
      specialist
        .replace('key: specialist', 'key: visitor')
        .replace('department: beta', 'department: alpha')
        .replace('prompts/specialist.md', 'prompts/visitor.md'),
      'utf8',
    );
    const prompts = path.join(consumer.rootDir, 'prompts');
    writeFileSync(
      path.join(prompts, 'visitor.md'),
      readFileSync(path.join(prompts, 'specialist.md'), 'utf8'),
      'utf8',
    );

    install('alpha', provider.rootDir);
    install('beta', consumer.rootDir);
    expect(getPackByKey(db, 'beta')!.last_validation_status).toBe('ok');

    // The next boot.
    revalidateInstalledPacks({
      db,
      activityLog,
      baseDir,
      appVersion: APP_VERSION,
      bundledPacksDir: path.resolve('packs'),
    });

    const beta = getPackByKey(db, 'beta')!;
    expect(beta.last_validation_error, 'beta failed revalidation').toBeNull();
    expect(beta.last_validation_status).toBe('ok');
    expect(isPackAvailable(db, 'beta')).toBe(true);
  });
});
