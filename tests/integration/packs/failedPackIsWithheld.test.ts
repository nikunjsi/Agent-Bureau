import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { recordPackValidation } from '../../../src/main/db/repositories/packs';
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { collectLayoutInputs } from '../../../src/main/company/persistFloorLayout';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { getHandler } from '../../../src/main/ipc/handlers';
import { getDbPaths } from '../../../src/main/db/paths';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * X-5 / §6.7 L1000: a pack that fails revalidation was withheld only at hire
 * and fire. Its departments still appeared in `company.listDepartments` and in
 * the floor layout, and `packs.list` reported `enabled: false` with no reason —
 * so the user saw a department they could not hire into and nothing said why.
 *
 * §6.7 keeps existing employees, so a failed pack withholds its departments and
 * roles from the surfaces, never the people already hired from it.
 */
describe('a pack that failed validation is withheld from the company and the floor (X-5)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;
  let companyId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-failedpack-'));
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
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'operations' });
    ctx = {
      db,
      activityLog,
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
    } as HandlerContext;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function call(namespace: 'company' | 'packs', method: string) {
    const result = await dispatchIpcCall(
      `${namespace}:${method}`,
      getMethodSchema(namespace, method),
      getHandler(namespace, method),
      ctx,
      true,
      {},
    );
    expect(result.ok, JSON.stringify(result).slice(0, 200)).toBe(true);
    return (result as { ok: true; data: { items: Array<Record<string, unknown>> } }).data.items;
  }

  it('its departments disappear from the company and the layout, its people stay, and packs.list says why', async () => {
    const developer = hireEmployee({
      db,
      activityLog,
      companyId,
      baseDir: tmpDir,
      roleKey: 'engineering:developer',
    }).employee;
    expect((await call('company', 'listDepartments')).map((d) => d['key'])).toContain(
      'engineering',
    );

    recordPackValidation(db, 'engineering', 'failed', 'roles/developer.yaml: something broke.');

    const departments = (await call('company', 'listDepartments')).map((d) => d['key']);
    expect(departments).not.toContain('engineering');
    expect(departments, 'a healthy pack is untouched').toContain('operations');

    expect(collectLayoutInputs(db, companyId).departments.map((d) => d.key)).not.toContain(
      'engineering',
    );

    // §6.7: existing employees are kept.
    expect(getEmployeeById(db, developer.id)).not.toBeNull();
    expect(() =>
      hireEmployee({ db, activityLog, companyId, baseDir: tmpDir, roleKey: 'engineering:tester' }),
    ).toThrow();

    const pack = (await call('packs', 'list')).find((p) => p['key'] === 'engineering')!;
    expect(pack['enabled']).toBe(false);
    expect(pack['lastValidationError']).toBe('roles/developer.yaml: something broke.');
    const healthy = (await call('packs', 'list')).find((p) => p['key'] === 'operations')!;
    expect(healthy['lastValidationError']).toBeNull();
  });
});
