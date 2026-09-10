import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { DIRECTOR_ROLE_FULL_KEY } from '../../../src/main/company/directorRole';
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { getRoleByFullKey } from '../../../src/main/db/repositories/roles';
import { setSetting } from '../../../src/main/db/repositories/settings';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';
import type { AgentEvent } from '../../../src/shared/engine/events';
import type { Employee } from '../../../src/shared/models/employee';
import type { Company } from '../../../src/shared/models/company';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * **Condition (b) on M9's close.**
 *
 * `budgetEnforcement`'s Director reserve carve-out has been written,
 * documented and unit-tested since M6 — and **has never run against a real
 * Director**, because until this milestone `hireEmployee` hardcoded
 * `is_director: false` and no production path could set the flag.
 * `directorReserveCarveOut.test.ts` proves the arithmetic by passing
 * `isDirector` in as a boolean; it says nothing about whether anything
 * ever passes `true`.
 *
 * That distinction is this project's most expensive recurring failure —
 * M6's budgets, M7's model tier, M8's `listPending`, M9's shared sequence
 * counter — four mechanisms that were correct, tested, and could not fire
 * on the real path. Hiring a Director made three more reachable in one
 * commit. This is the one that spends money, so it is the one demonstrated
 * end to end.
 *
 * ## The whole chain is production code
 *
 * `hireEmployee` writes `is_director` → `Supervisor.assign()` reads
 * `ctx.employee.is_director` → `recordUsage` passes it to `enforceBudget`
 * → `reserveCarveOut` subtracts (or does not). Nothing here sets the flag,
 * and nothing here calls `enforceBudget` directly. The only fixture is
 * `FakeAdapter`, which fakes the engine process exactly as it does
 * everywhere else.
 */
describe('the Director reserve, fired by a real hired Director (§8.0/§11.5)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let registry: SupervisorRegistry;
  let company: Company;
  let live: Supervisor[];

  // $20.00 daily, $2.00 held for the Director. Employees therefore stop at
  // $18.00; the Director may draw the full $20.00.
  const DAILY_USD = 20;
  const RESERVE_USD = 2;
  // One turn that lands BETWEEN the two ceilings: over $18.00, under
  // $20.00. That gap is the carve-out, and nothing else in the system
  // distinguishes it.
  const TURN_COST_MICROS = 19_000_000;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-reserve-live-'));
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
    registry = new SupervisorRegistry();
    live = [];
    company = seedCompany(db, tmpDir);
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'operations' });
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'engineering' });

    setSetting(db, 'budgets.dailyUsd', DAILY_USD);
    setSetting(db, 'budgets.directorReserveUsd', RESERVE_USD);
    setSetting(db, 'budgets.onExceed', 'park');
    // Out of the way: this test is about the global-daily level, and a
    // per-task or per-employee-daily limit crossing first would prove the
    // wrong branch.
    setSetting(db, 'budgets.perTaskUsd', 1000);
    setSetting(db, 'budgets.perEmployeeDailyUsd', 1000);
    setSetting(db, 'budgets.projectUsd', 1000);
  });

  afterEach(async () => {
    await Promise.all(live.map((supervisor) => supervisor.stop()));
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function hire(roleKey: string): Employee {
    return hireEmployee({
      db,
      activityLog,
      companyId: company.id,
      baseDir: tmpDir,
      roleKey,
    }).employee;
  }

  /** A real Supervisor over a FakeAdapter that bills one turn. `assign()`
   * is the production entry point and is where `is_director` is read. */
  async function runOneTurn(employee: Employee, costMicros: number): Promise<void> {
    const role = getRoleByFullKey(db, employee.role_key)!;
    const events: AgentEvent[] = [
      { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
      { t: 'turn.started', turnIndex: 0 },
      {
        t: 'turn.completed',
        turnIndex: 0,
        usage: {
          tokensIn: 100,
          tokensOut: 50,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          model: 'claude-sonnet-5',
          costUsdMicros: costMicros,
        },
      },
    ];
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter: new FakeAdapter({ events }),
      supervisorRegistry: registry,
      heartbeatCheckIntervalMs: 999_999_999,
    });
    live.push(supervisor);
    await supervisor.assign({
      employee,
      role,
      task: null,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: 'guided',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  it('parks an ordinary employee at (daily − reserve) — the carve-out, from below', async () => {
    const developer = hire('engineering:developer');
    await runOneTurn(developer, TURN_COST_MICROS);

    // $19.00 spent against an $18.00 effective ceiling. The row, not the
    // supervisor's in-memory state: the same discipline S7 uses.
    expect(getEmployeeById(db, developer.id)?.status).toBe('parked');
    const exceeded = db
      .prepare(
        "SELECT payload FROM events WHERE type = 'employee.budget_exceeded' AND employee_id = ?",
      )
      .all(developer.id) as { payload: string }[];
    expect(exceeded.length).toBe(1);
    expect(JSON.parse(exceeded[0]!.payload)).toEqual({ level: 'globalDaily' });
  });

  it('does NOT park the Director on the identical spend — the branch fires', async () => {
    const director = hire(DIRECTOR_ROLE_FULL_KEY);
    // The flag came from the hire, not from this test.
    expect(director.is_director).toBe(true);

    await runOneTurn(director, TURN_COST_MICROS);

    // $19.00 against the FULL $20.00 ceiling: under it, so no crossing.
    expect(getEmployeeById(db, director.id)?.status).not.toBe('parked');
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE type = 'employee.budget_exceeded' AND employee_id = ?",
        )
        .get(director.id),
    ).toEqual({ n: 0 });
  });

  it('parks the Director too once even the reserve is gone, and raises §8.0’s approval checkpoint', async () => {
    // The other side of the same branch, and the reason the carve-out is
    // not an exemption: the Director's own check uses the full ceiling, so
    // crossing IT means nothing is left. §8.0 then wants a real
    // checkpoint, not silence.
    const director = hire(DIRECTOR_ROLE_FULL_KEY);
    await runOneTurn(director, 21_000_000);

    expect(getEmployeeById(db, director.id)?.status).toBe('parked');
    const checkpoints = db
      .prepare("SELECT title, type, urgency FROM checkpoints WHERE type = 'approval'")
      .all() as { title: string; type: string; urgency: string }[];
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0]!.title).toMatch(/Budget exhausted/i);
    expect(checkpoints[0]!.urgency).toBe('blocking');
  });
});
