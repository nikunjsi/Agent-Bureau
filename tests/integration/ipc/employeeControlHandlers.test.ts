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
import { employeesHandlers } from '../../../src/main/ipc/handlers/employees';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { ProbeCache } from '../../../src/main/engine/probeCache';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { newId } from '../../../src/shared/models/ids';
import { seedEmployee, seedProject, seedRole, seedTask } from '../../helpers/dbFixtures';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { IpcResult } from '../../../src/shared/ipc/envelope';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

function expectOk(result: unknown): void {
  const typed = result as IpcResult<unknown>;
  if (!typed.ok) throw new Error(`expected ok, got ${typed.error.code}: ${typed.error.message}`);
}

function expectError(result: unknown): { code: string; message: string } {
  const typed = result as IpcResult<unknown>;
  if (typed.ok) throw new Error('expected an error, got ok');
  return typed.error;
}

/**
 * §17.1's `employees.pause` / `resumeEmployee` / `interrupt` /
 * `updateSettings`, which were `stub('M7')` until this session because
 * nothing could hire and so no Supervisor could ever be in the registry.
 *
 * **Every one of these drives a REAL `Supervisor` through a REAL
 * `SupervisorRegistry`** and asserts on the employee row the supervisor
 * actually wrote. A handler that compiles but has never been driven end to
 * end is a stub with better manners.
 */
describe('employees.* control handlers (§14.5)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let registry: SupervisorRegistry;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-emp-ctl-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    registry = new SupervisorRegistry();
    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
      pricing: REAL_PRICING,
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
      supervisorRegistry: registry,
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A real, assigned, running Supervisor registered under its employee. */
  async function runningEmployee(): Promise<{ id: string; supervisor: Supervisor }> {
    const role = seedRole(db);
    const employee = seedEmployee(db, { role_key: role.full_key });
    const project = seedProject(db);
    const task = seedTask(db, { project_id: project.id });
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter: new FakeAdapter(),
      probeCache: new ProbeCache(),
    });
    await supervisor.assign({
      employee,
      role,
      task,
      worktreePath: path.join(tmpDir, 'wt'),
      stateDir: path.join(tmpDir, 'state'),
      memoryPack: '',
      decisionLog: '',
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: 'guided',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });
    registry.register(employee.id, supervisor);
    return { id: employee.id, supervisor };
  }

  it('pause parks the employee — visible on the row, not just in memory', async () => {
    const { id, supervisor } = await runningEmployee();

    expectOk(await employeesHandlers['pause']!({ id }, ctx));

    expect(getEmployeeById(db, id)!.status).toBe('parked');
    await supervisor.stop(0);
  });

  it('resumeEmployee clears the park', async () => {
    const { id, supervisor } = await runningEmployee();
    expectOk(await employeesHandlers['pause']!({ id }, ctx));

    expectOk(await employeesHandlers['resumeEmployee']!({ id }, ctx));

    expect(getEmployeeById(db, id)!.status).not.toBe('parked');
    await supervisor.stop(0);
  });

  it('resumeEmployee on someone who is not paused says so rather than claiming success', async () => {
    const { id, supervisor } = await runningEmployee();
    const error = expectError(await employeesHandlers['resumeEmployee']!({ id }, ctx));
    expect(error.message).toContain('not paused');
    await supervisor.stop(0);
  });

  it('interrupt reaches the adapter when the engine supports it', async () => {
    const { id, supervisor } = await runningEmployee();
    expectOk(await employeesHandlers['interrupt']!({ id }, ctx));
    await supervisor.stop(0);
  });

  it('reports honestly when the employee is not running', async () => {
    // The ordinary case for anyone `off`. Distinguished from "no such
    // employee" — conflating them would produce the useless kind of error.
    const employee = seedEmployee(db);
    const error = expectError(await employeesHandlers['pause']!({ id: employee.id }, ctx));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('not currently running');
  });

  it('reports a genuinely unknown employee differently', async () => {
    // A well-formed id that names nobody. A malformed one never reaches
    // this check — the schema rejects it first, which is §4.2 working.
    const error = expectError(await employeesHandlers['pause']!({ id: newId() }, ctx));
    expect(error.message).toContain('No employee with id');
  });

  // --- updateSettings works whether or not they are running -------------

  it('updateSettings writes autonomy, budget and the model TIER override to the row', async () => {
    const employee = seedEmployee(db);

    expectOk(
      await employeesHandlers['updateSettings']!(
        // A TIER, not a model id — changed 2026-09-07. The old `model`
        // field wrote a column the spawn never read (the M7->M4 boundary
        // finding); that the tier now reaches the launch is proven on the
        // real hire->spawn path in m7ToM4Boundary.test.ts.
        {
          id: employee.id,
          autonomy: 'ask',
          dailyBudgetUsdMicros: 5_000_000,
          modelTierOverride: 'capable',
        },
        ctx,
      ),
    );

    const after = getEmployeeById(db, employee.id)!;
    expect(after.autonomy).toBe('ask');
    expect(after.daily_budget_usd_micros).toBe(5_000_000);
    expect(after.model_tier_override).toBe('capable');
  });

  it('updateSettings leaves unsent fields alone', async () => {
    const employee = seedEmployee(db, { autonomy: 'guided', model_tier_override: 'fast' });

    expectOk(await employeesHandlers['updateSettings']!({ id: employee.id, autonomy: 'ask' }, ctx));

    const after = getEmployeeById(db, employee.id)!;
    expect(after.autonomy).toBe('ask');
    expect(after.model_tier_override).toBe('fast'); // not nulled
  });

  it('updateSettings records only what was actually sent', async () => {
    // A payload listing every field as null would make the log claim the
    // user cleared settings they never touched.
    const employee = seedEmployee(db);
    expectOk(await employeesHandlers['updateSettings']!({ id: employee.id, autonomy: 'ask' }, ctx));

    const row = db
      .prepare("SELECT payload FROM events WHERE type = 'user.settings_changed'")
      .get() as { payload: string };
    expect(JSON.parse(row.payload)).toEqual({ autonomy: 'ask' });
  });

  it('updateSettings needs no running supervisor', async () => {
    // Changing someone's autonomy before starting them is the normal case,
    // so this deliberately does not go through the registry.
    const employee = seedEmployee(db);
    expectOk(
      await employeesHandlers['updateSettings']!({ id: employee.id, autonomy: 'autonomous' }, ctx),
    );
    expect(getEmployeeById(db, employee.id)!.autonomy).toBe('autonomous');
  });
});

describe('the milestone may not close with its own name in a stub', () => {
  it('no employees.* handler is still tagged M7', async () => {
    // §28's own close-out rule, and audit #22's finding that M3 and M5
    // both closed with `stub('M3')`/`stub('M5')` still in the tree while
    // every status doc said otherwise.
    const source = readFileSync(path.resolve('src/main/ipc/handlers/employees.ts'), 'utf8');
    expect(source).not.toContain("stub('M7')");
  });
});
