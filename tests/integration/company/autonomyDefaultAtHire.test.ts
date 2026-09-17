import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { DIRECTOR_ROLE_FULL_KEY } from '../../../src/main/company/directorRole';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';
import type { Company } from '../../../src/shared/models/company';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * N-7 / §16.1 `autonomy.default`, decided at pre-M11 (§E-3): wired at hire.
 *
 * A new hire takes the STRICTER of the global setting and the role's own
 * `autonomy_default` (ask < guided < autonomous). Every shipped role declares
 * a default, so "global, then role" would leave the setting dead again; the
 * stricter-of rule lets a user make every new hire more careful company-wide
 * without letting a global setting loosen a role its author made careful.
 * The per-employee value is what the user changes afterwards. The Director is
 * fixed at `guided` (§8.0) and ignores the setting.
 */
describe('autonomy.default is consulted at hire (N-7, §16.1)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let company: Company;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-autonomy-default-'));
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
    company = seedCompany(db, tmpDir);
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'operations' });
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'engineering' });
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function hire(roleKey: string) {
    return hireEmployee({ db, activityLog, companyId: company.id, baseDir: tmpDir, roleKey })
      .employee;
  }

  it('a global `ask` makes a new hire of a `guided` role start at ask', () => {
    setSetting(db, 'autonomy.default', 'ask');
    expect(hire('engineering:developer').autonomy).toBe('ask');
  });

  it('the default global `guided` leaves a `guided` role at guided', () => {
    expect(hire('engineering:developer').autonomy).toBe('guided');
  });

  it('a global `autonomous` never loosens a role past its own default', () => {
    setSetting(db, 'autonomy.default', 'autonomous');
    expect(hire('engineering:developer').autonomy).toBe('guided');
  });

  it('a role authored at `ask` stays at ask under a looser global', () => {
    db.prepare("UPDATE roles SET autonomy_default = 'ask' WHERE full_key = ?").run(
      'engineering:tester',
    );
    expect(hire('engineering:tester').autonomy).toBe('ask');
  });

  it('the Director is fixed at guided whatever the global says (§8.0)', () => {
    setSetting(db, 'autonomy.default', 'ask');
    expect(hire(DIRECTOR_ROLE_FULL_KEY).autonomy).toBe('guided');
  });
});
