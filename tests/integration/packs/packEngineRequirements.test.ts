import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import {
  isPackAvailable,
  revalidateInstalledPacks,
  revalidatePackEngines,
} from '../../../src/main/packs/revalidateInstalledPacks';
import { getPackByKey } from '../../../src/main/db/repositories/packs';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';
import type { ProbeResult } from '../../../src/shared/engine/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

function probe(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    installed: true,
    authenticated: true,
    version: '2.1.238',
    binaryPath: 'C:/x/claude.exe',
    error: null,
    metered: true,
    determination: 'determined',
    ...overrides,
  };
}

/**
 * X-2 / §6.3 L863: `requires.engines` means "at least one must be available",
 * and it was parsed and never checked. Now, after startup revalidation, each
 * installed pack's engines are probed. A pack none of whose engines is
 * installed is recorded as failed with a readable reason, which withholds it
 * from hiring. A probe that could not finish (`indeterminate`) is not proof of
 * absence, so it never makes a pack unavailable on its own.
 */
describe('a pack whose required engines are all missing is unavailable (X-2, §6.3)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  const options = () => ({
    db,
    activityLog,
    baseDir: tmpDir,
    appVersion: '0.0.1',
    bundledPacksDir: path.resolve('packs'),
  });

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-packengines-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    companyId = seedCompany(db, tmpDir).id;
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'engineering' });
    revalidateInstalledPacks(options());
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const hireDeveloper = () =>
    hireEmployee({ db, activityLog, companyId, baseDir: tmpDir, roleKey: 'engineering:developer' });

  it('none installed: the pack is failed with a readable reason, an event is emitted, and hiring is refused', async () => {
    const probed: string[] = [];
    await revalidatePackEngines({
      ...options(),
      probeEngine: async (engineKey) => {
        probed.push(engineKey);
        return probe({ installed: false, binaryPath: null });
      },
    });
    expect(probed).toEqual(['claude-code']);
    const pack = getPackByKey(db, 'engineering')!;
    expect(pack.last_validation_status).toBe('failed');
    expect(pack.last_validation_error).toMatch(/claude-code/);
    expect(pack.last_validation_error).toMatch(/installed/i);
    expect(isPackAvailable(db, 'engineering')).toBe(false);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'company.pack_validation_failed'")
        .get(),
    ).toEqual({ n: 1 });
    expect(hireDeveloper).toThrow();
  });

  it('an engine the app has no adapter for counts as not installed', async () => {
    await revalidatePackEngines({ ...options(), probeEngine: async () => null });
    expect(isPackAvailable(db, 'engineering')).toBe(false);
  });

  it('installed: the pack stays available and hiring works', async () => {
    await revalidatePackEngines({ ...options(), probeEngine: async () => probe({}) });
    expect(getPackByKey(db, 'engineering')!.last_validation_status).toBe('ok');
    expect(isPackAvailable(db, 'engineering')).toBe(true);
    expect(hireDeveloper().employee.role_key).toBe('engineering:developer');
  });

  it('a probe that could not finish does not make the pack unavailable', async () => {
    await revalidatePackEngines({
      ...options(),
      probeEngine: async () => probe({ installed: false, determination: 'indeterminate' }),
    });
    expect(isPackAvailable(db, 'engineering')).toBe(true);
  });
});
