import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { packsHandlers } from '../../../src/main/ipc/handlers/packs';
import { employeesHandlers } from '../../../src/main/ipc/handlers/employees';
import { getPackByKey, setPackEnabled, recordPackValidation } from '../../../src/main/db/repositories/packs';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { IpcResult } from '../../../src/shared/ipc/envelope';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));
const BUNDLED_PACKS_DIR = path.resolve('packs');
const APP_VERSION = (JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version: string })
  .version;

function unwrap<T>(result: unknown): T {
  const typed = result as IpcResult<T>;
  if (!typed.ok) throw new Error(`expected ok, got ${typed.error.code}: ${typed.error.message}`);
  return typed.data;
}

function expectError(result: unknown): { code: string; message: string } {
  const typed = result as IpcResult<unknown>;
  if (typed.ok) throw new Error('expected an error, got ok');
  return typed.error;
}

interface PackListOutput {
  items: { key: string; name: string; version: string; enabled: boolean; departments: string[] }[];
}

/**
 * §17's five `packs.*` methods, driven through the real handlers against
 * the real shipped pack directory — the same objects `registerIpcRouter`
 * wires up, not stand-ins.
 */
describe('packs.* IPC handlers (§17, M7)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-packs-ipc-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    ctx = {
      db,
      activityLog: ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db),
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
      pricing: REAL_PRICING,
      baseDir: tmpDir,
      bundledPacksDir: BUNDLED_PACKS_DIR,
      appVersion: APP_VERSION,
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists bundled packs that have not been installed yet', async () => {
    // Without this, a fresh install shows an empty Packs screen and no way
    // to get anywhere from it.
    const data = unwrap<PackListOutput>(await packsHandlers['list']!({}, ctx));
    expect(data.items.map((i) => i.key)).toEqual(['engineering', 'operations']);
    expect(data.items.every((i) => i.enabled === false)).toBe(true);
  });

  it('validates a bundled pack by key', async () => {
    const data = unwrap<{ valid: boolean; errors: string[] }>(
      await packsHandlers['validate']!({ source: 'engineering' }, ctx),
    );
    expect(data).toEqual({ valid: true, errors: [] });
  });

  it('reports a missing source as invalid rather than throwing', async () => {
    const data = unwrap<{ valid: boolean; errors: string[] }>(
      await packsHandlers['validate']!({ source: 'nonexistent' }, ctx),
    );
    expect(data.valid).toBe(false);
    expect(data.errors[0]).toContain('No pack found');
  });

  it('installs a bundled pack and then lists it as enabled', async () => {
    unwrap(await packsHandlers['install']!({ source: 'engineering' }, ctx));

    const data = unwrap<PackListOutput>(await packsHandlers['list']!({}, ctx));
    const engineering = data.items.find((i) => i.key === 'engineering');
    expect(engineering?.enabled).toBe(true);
    expect(engineering?.departments).toEqual(['engineering']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 5 });
  });

  it('returns a readable, actionable error when a pack fails to install', async () => {
    const error = expectError(await packsHandlers['install']!({ source: 'nonexistent' }, ctx));
    expect(error.code).toBe('NOT_FOUND');
    // §14.6: plain language, and a concrete next action.
    expect(error.message).not.toContain('ENOENT');
    expect(error.message).toContain('nonexistent');
  });

  it('reports a pack that failed validation as not enabled, without touching the stored intent', async () => {
    unwrap(await packsHandlers['install']!({ source: 'engineering' }, ctx));
    recordPackValidation(db, 'engineering', 'failed', 'roles/developer.yaml: prompt file is missing');

    const data = unwrap<PackListOutput>(await packsHandlers['list']!({}, ctx));
    expect(data.items.find((i) => i.key === 'engineering')?.enabled).toBe(false);
    // The user never switched it off, and the row still says so — fixing
    // the pack brings it back with no second action.
    expect(getPackByKey(db, 'engineering')?.enabled).toBe(true);
  });

  it('setEnabled writes the user’s intent, and list reflects it', async () => {
    unwrap(await packsHandlers['install']!({ source: 'engineering' }, ctx));
    unwrap(await packsHandlers['setEnabled']!({ key: 'engineering', enabled: false }, ctx));

    expect(getPackByKey(db, 'engineering')?.enabled).toBe(false);
    const data = unwrap<PackListOutput>(await packsHandlers['list']!({}, ctx));
    expect(data.items.find((i) => i.key === 'engineering')?.enabled).toBe(false);
  });

  it('setEnabled on a pack that is not installed is NOT_FOUND', async () => {
    setPackEnabled(db, 'ghost', true); // no-op; the row does not exist
    const error = expectError(await packsHandlers['setEnabled']!({ key: 'ghost', enabled: true }, ctx));
    expect(error.code).toBe('NOT_FOUND');
  });

  it('scaffolds a pack that then validates and installs through the same handlers', async () => {
    unwrap(await packsHandlers['scaffold']!({ name: 'marketing' }, ctx));

    const validated = unwrap<{ valid: boolean; errors: string[] }>(
      await packsHandlers['validate']!({ source: path.join(tmpDir, 'packs', 'marketing') }, ctx),
    );
    expect(validated).toEqual({ valid: true, errors: [] });

    unwrap(await packsHandlers['install']!({ source: path.join(tmpDir, 'packs', 'marketing') }, ctx));
    expect(getPackByKey(db, 'marketing')?.origin).toBe('user');
  });

  it('refuses to scaffold over an existing pack, in plain language', async () => {
    unwrap(await packsHandlers['scaffold']!({ name: 'marketing' }, ctx));
    const error = expectError(await packsHandlers['scaffold']!({ name: 'marketing' }, ctx));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('already exists');
  });
});

describe('employees.* stub milestones say the truth', () => {
  it('the four Inspector methods are tagged M14, not M7', async () => {
    // M7 arrived and did not implement them. A stub naming the wrong
    // milestone reads as an oversight rather than a plan.
    for (const method of ['takeControl', 'releaseControl', 'sendInput', 'resizePty']) {
      const result = (await employeesHandlers[method]!({}, {} as HandlerContext)) as IpcResult<unknown>;
      expect(result.ok, method).toBe(false);
      if (result.ok) continue;
      expect(result.error.message, method).toContain('M14');
    }
  });

  it('the four that needed the Supervisor registry are no longer stubs', async () => {
    // Session 1 asserted these WERE `stub('M7')`, which was true then and
    // is the point: the milestone could not close while its own name was
    // still in a stub marker. Session 2 built them, so this assertion is
    // inverted rather than deleted — a stub returns NOT_IMPLEMENTED, and
    // none of these may.
    for (const method of ['pause', 'resumeEmployee', 'interrupt', 'updateSettings']) {
      let result: IpcResult<unknown>;
      try {
        result = (await employeesHandlers[method]!(
          { id: 'x' },
          { db: null, supervisorRegistry: undefined } as unknown as HandlerContext,
        )) as IpcResult<unknown>;
      } catch {
        // Threw on the deliberately-broken context — which is itself proof
        // it is doing real work rather than returning a canned stub.
        continue;
      }
      // They fail here (no real context), but they must fail as REAL
      // handlers do — never with the stub's own code.
      if (result.ok) continue;
      expect(result.error.code, method).not.toBe('NOT_IMPLEMENTED');
    }
  });
});
