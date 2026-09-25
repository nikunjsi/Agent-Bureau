import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { companyHandlers } from '../../../src/main/ipc/handlers/company';
import { getEmployeeById, listEmployees } from '../../../src/main/db/repositories/employees';
import { insertEmployee } from '../../../src/main/db/repositories/employees';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { IpcResult } from '../../../src/shared/ipc/envelope';
import type { Employee } from '../../../src/shared/models/employee';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

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

/**
 * §17.1's `company.*` methods, driven through the real handlers. These
 * were `stub('M7')` until this session because the operations behind them
 * did not exist.
 */
describe('company.* handlers (§17.1)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-company-ipc-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
      pricing: REAL_PRICING,
      baseDir: path.join(tmpDir, 'userData'),
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setUpCompany(): void {
    seedCompany(db, path.join(tmpDir, 'home'));
    installShippedPack({ db, activityLog, baseDir: ctx.baseDir, packKey: 'engineering' });
  }

  it('says so plainly when no company has been set up', async () => {
    // The honest state of the product: nothing creates a company until
    // M13's wizard, and a crash three layers down would be worse.
    const error = expectError(
      await companyHandlers['hire']!({ roleKey: 'engineering:developer' }, ctx),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('setup wizard');
  });

  it('hires through IPC and returns the employee', async () => {
    setUpCompany();
    const data = unwrap<{ item: Employee }>(
      await companyHandlers['hire']!({ roleKey: 'engineering:developer' }, ctx),
    );
    expect(data.item.role_key).toBe('engineering:developer');
    expect(listEmployees(db)).toHaveLength(1);
  });

  it('accepts an explicit name and reports a collision in plain language', async () => {
    setUpCompany();
    unwrap(
      await companyHandlers['hire']!({ roleKey: 'engineering:developer', name: 'Quinn' }, ctx),
    );

    const error = expectError(
      await companyHandlers['hire']!({ roleKey: 'engineering:tester', name: 'Quinn Sharma' }, ctx),
    );
    expect(error.message).toContain('first name');
    expect(error.message).not.toContain('SqliteError');
  });

  it('fires through IPC, archiving rather than deleting', async () => {
    setUpCompany();
    const hired = unwrap<{ item: Employee }>(
      await companyHandlers['hire']!({ roleKey: 'engineering:developer' }, ctx),
    );

    unwrap(await companyHandlers['fire']!({ id: hired.item.id }, ctx));

    expect(listEmployees(db)).toHaveLength(0);
    expect(getEmployeeById(db, hired.item.id)!.archived_at).not.toBeNull();
  });

  it('refuses to fire the Director, and explains why', async () => {
    setUpCompany();
    const director = insertEmployee(db, {
      name: 'Director',
      role_key: 'engineering:developer',
      is_director: true,
      desk_x: 1,
      desk_y: 1,
      sprite_variant: 'director_0',
      engine: 'claude-code',
      autonomy: 'guided',
    });

    const error = expectError(await companyHandlers['fire']!({ id: director.id }, ctx));
    expect(error.message).toContain('cannot be fired');
    // The message says WHY, not just no — §14.6.
    expect(error.message).toContain('no way to hire a replacement');
  });

  it('renames through IPC', async () => {
    setUpCompany();
    const hired = unwrap<{ item: Employee }>(
      await companyHandlers['hire']!({ roleKey: 'engineering:developer' }, ctx),
    );

    unwrap(await companyHandlers['rename']!({ id: hired.item.id, name: 'Morgan' }, ctx));
    expect(getEmployeeById(db, hired.item.id)!.name).toBe('Morgan');
  });

  it('lists departments', async () => {
    setUpCompany();
    const data = unwrap<{ items: { key: string }[] }>(
      await companyHandlers['listDepartments']!({}, ctx),
    );
    expect(data.items.map((d) => d.key)).toEqual(['engineering']);
  });

  it('moves a desk and persists it', async () => {
    setUpCompany();
    const a = unwrap<{ item: Employee }>(
      await companyHandlers['hire']!({ roleKey: 'engineering:developer' }, ctx),
    );
    const b = unwrap<{ item: Employee }>(
      await companyHandlers['hire']!({ roleKey: 'engineering:tester' }, ctx),
    );

    unwrap(
      await companyHandlers['moveDesk']!(
        { id: a.item.id, deskX: b.item.desk_x, deskY: b.item.desk_y },
        ctx,
      ),
    );

    const moved = getEmployeeById(db, a.item.id)!;
    expect({ x: moved.desk_x, y: moved.desk_y }).toEqual({ x: b.item.desk_x, y: b.item.desk_y });
  });

  it('refuses a desk that is not a desk', async () => {
    setUpCompany();
    const hired = unwrap<{ item: Employee }>(
      await companyHandlers['hire']!({ roleKey: 'engineering:developer' }, ctx),
    );
    const error = expectError(
      await companyHandlers['moveDesk']!({ id: hired.item.id, deskX: 0, deskY: 23 }, ctx),
    );
    expect(error.message).toContain('not a desk');
  });
});

describe('M7 may not close with its own name in a stub (audit #22)', () => {
  it("no src/ file still contains stub('M7')", () => {
    // M3 and M5 both closed with `stub('M3')`/`stub('M5')` in the tree
    // while every status document said the milestone was done. A grep in a
    // checklist is a step someone can skip; this is not.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        if (readFileSync(full, 'utf8').includes("stub('M7')")) {
          offenders.push(path.relative(process.cwd(), full));
        }
      }
    };
    walk(path.resolve('src'));

    expect(offenders, `still tagged M7: ${offenders.join(', ')}`).toEqual([]);
  });
});
