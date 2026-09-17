import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { nowIso, newId } from '../../../src/shared/models/ids';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee, getEmployeeById } from '../../../src/main/db/repositories/employees';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertTask } from '../../../src/main/db/repositories/tasks';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';
import type { AgentEvent } from '../../../src/shared/engine/events';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

function baseRoleInput(overrides: Record<string, unknown> = {}) {
  return {
    key: `developer-${newId()}`,
    department_key: 'engineering',
    pack_id: 'engineering',
    version: '1.0.0',
    title: 'Developer',
    description: 'Writes code',
    system_prompt_path: 'prompts/developer.md',
    skills: ['code'],
    deliverable_types: ['code'],
    engine_preference: ['claude-code'],
    tools_allow: [],
    tools_deny: [],
    memory_scopes: ['role'],
    autonomy_default: 'guided',
    sprite_key: 'dev',
    engine_options: null,
    budget_usd_micros: null,
    ...overrides,
  };
}

/**
 * §16.1/§28 M6 item 8 — real budget enforcement wired into Supervisor's
 * `recordUsage()` seam, proven end to end: a real Supervisor, a real
 * employee with a tiny task budget, real `turn.completed` events carrying
 * real usage, through the real `insertUsage`/`enforceBudget` call chain
 * (no mocking of either).
 */
describe('Supervisor budget enforcement (§11.5/§16.1, security test S7)', () => {
  let tmpDir: string;
  let activityLogPath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-supervisor-budget-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    activityLogPath = path.join(tmpDir, 'activity.jsonl');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(activityLogPath, db);
    const now = nowIso();
    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', '{}', now, now);
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readActivityLogLines(): unknown[] {
    if (!existsSync(activityLogPath)) return [];
    return readFileSync(activityLogPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown);
  }

  function makeEmployeeWithTinyTaskBudget(taskBudgetMicros: number, isDirector = false) {
    const role = insertRole(db, baseRoleInput({ budget_usd_micros: taskBudgetMicros }) as never);
    const employee = insertEmployee(db, {
      name: `Ravi-${newId()}`,
      role_key: role.full_key,
      is_director: isDirector,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'off',
      status_detail: null,
      engine: 'claude-code',
      engine_mode: null,
      engine_version: null,
      model: null,
      session_id: null,
      pid: null,
      process_start_time: null,
      worktree_id: null,
      current_task_id: null,
      autonomy: 'guided',
      daily_budget_usd_micros: null,
      resume_at: null,
      heartbeat_at: null,
      consecutive_failures: 0,
      lifetime_spend_usd_micros: 0,
    } as never);
    return { role, employee };
  }

  function makeCtx(
    role: ReturnType<typeof makeEmployeeWithTinyTaskBudget>['role'],
    employee: ReturnType<typeof makeEmployeeWithTinyTaskBudget>['employee'],
    task: { id: string; project_id: string; body: string } | null,
  ): EmployeeContext {
    return {
      employee,
      role,
      task: task as never,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: 'ask',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };
  }

  function turnCompletedEvent(turnIndex: number, costUsdMicros: number): AgentEvent {
    return {
      t: 'turn.completed',
      turnIndex,
      usage: {
        tokensIn: 100,
        tokensOut: 50,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        model: 'claude-sonnet-5',
        costUsdMicros,
      },
    };
  }

  it('S7 budget_stops_runaway: an employee that crosses its task budget is PARKED, not merely warned — and stays stopped, not just warned once', async () => {
    // Real onExceed=park (§16.1's own default) — set explicitly so the test
    // does not depend on the schema default silently changing later.
    setSetting(db, 'budgets.onExceed', 'park');

    const { role, employee } = makeEmployeeWithTinyTaskBudget(1000); // $0.001 task budget — trivially crossed
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'A task',
      body: 'Do the thing.',
      acceptance_criteria: ['done'],
    });

    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        turnCompletedEvent(0, 5000), // 5000 micros >> 1000 micro budget — crosses on the very first turn
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, task));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // The real fact, not internal bookkeeping: queried from the DB, the
    // same discipline S1/S2 used.
    expect(getEmployeeById(db, employee.id)?.status).toBe('parked');
    expect(supervisor.currentState).toBe('parked');

    const entries = readActivityLogLines() as Array<{
      type: string;
      employee_id: string | null;
      payload: unknown;
    }>;
    const exceededEvent = entries.find(
      (e) => e.type === 'employee.budget_exceeded' && e.employee_id === employee.id,
    );
    expect(exceededEvent, JSON.stringify(entries)).toBeDefined();
    expect(exceededEvent?.payload).toEqual({ level: 'task' });

    // The actual "stopped taking turns" proof, not just a status string:
    // a subsequent turn.completed after parking does not un-park the
    // employee or resume 'working' — nothing in this codebase currently
    // un-parks a budget-parked employee mid-session (only the resume tick,
    // which is resume_at-driven and irrelevant here, or a real checkpoint
    // resolution, which nothing auto-resolves).
    (adapter as unknown as { pushEvent?: (e: AgentEvent) => void }).pushEvent?.(
      turnCompletedEvent(1, 1),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(getEmployeeById(db, employee.id)?.status).toBe('parked');
  });

  it('mutation check: with enforceBudget never called (simulated by leaving the task budget unset), the identical scenario never parks — proves the enforcement, not the scenario, causes the park', async () => {
    // No budget_usd_micros override and no budgets.perTaskUsd override —
    // real default is $2.00 (2,000,000 micros), and this turn's cost
    // (5000 micros) never approaches it. This is the same "remove the
    // enforcement, confirm the employee stays working" check the S7 spec
    // requires, done the same way S1/S2 proved non-execution: by removing
    // the one thing that would trigger it (here, a budget small enough to
    // cross) rather than editing production source for the test.
    const { role, employee } = makeEmployeeWithTinyTaskBudget(null as unknown as number);
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'A task',
      body: 'Do the thing.',
      acceptance_criteria: ['done'],
    });

    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        turnCompletedEvent(0, 5000),
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, task));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(getEmployeeById(db, employee.id)?.status).not.toBe('parked');
    const entries = readActivityLogLines() as Array<{ type: string }>;
    expect(entries.some((e) => e.type === 'employee.budget_exceeded')).toBe(false);
  });

  it('onExceed=stop calls a real stop(), transitioning through stopping to off, not park', async () => {
    setSetting(db, 'budgets.onExceed', 'stop');
    const { role, employee } = makeEmployeeWithTinyTaskBudget(1000);
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'A task',
      body: 'Do the thing.',
      acceptance_criteria: ['done'],
    });

    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        turnCompletedEvent(0, 5000),
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, task));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(getEmployeeById(db, employee.id)?.status).toBe('off');
  });

  it('N-16 onExceed=stop: the Director is parked, never stopped — a stopped Director leaves nobody to raise the budget with (§8.0)', async () => {
    setSetting(db, 'budgets.onExceed', 'stop');
    // The per-task level applies to the Director normally (§8.0's table),
    // so a tiny role budget really does produce a `stop` verdict for it.
    const { role, employee: director } = makeEmployeeWithTinyTaskBudget(1000, true);
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'A task',
      body: 'Do the thing.',
      acceptance_criteria: ['done'],
    });

    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        turnCompletedEvent(0, 5000),
      ],
    });
    const supervisor = new Supervisor(director.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, director, task));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(getEmployeeById(db, director.id)?.status).toBe('parked');
    expect(supervisor.currentState).toBe('parked');
  });

  it('warn crossing at 80% emits employee.budget_warning and cost.budget_threshold without parking', async () => {
    const { role, employee } = makeEmployeeWithTinyTaskBudget(1_000_000); // $1.00 task budget
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'A task',
      body: 'Do the thing.',
      acceptance_criteria: ['done'],
    });

    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        turnCompletedEvent(0, 850_000), // crosses the 80% ($800,000) warn threshold, stays under the $1,000,000 hard limit
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, task));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(getEmployeeById(db, employee.id)?.status).not.toBe('parked');
    const entries = readActivityLogLines() as Array<{ type: string; employee_id: string | null }>;
    expect(
      entries.some((e) => e.type === 'employee.budget_warning' && e.employee_id === employee.id),
    ).toBe(true);
    expect(
      entries.some((e) => e.type === 'cost.budget_threshold' && e.employee_id === employee.id),
    ).toBe(true);
    expect(entries.some((e) => e.type === 'employee.budget_exceeded')).toBe(false);
  });

  it('a non-Director employee stops at (project budget - directorReserve), not the full project budget — the carve-out, proven through the real Supervisor path', async () => {
    setSetting(db, 'budgets.projectUsd', 10.0); // $10 project budget
    setSetting(db, 'budgets.directorReserveUsd', 2.0); // $2 reserve
    setSetting(db, 'budgets.perTaskUsd', 1000.0); // effectively unlimited — isolates the assertion to the project level
    setSetting(db, 'budgets.onExceed', 'park');

    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });

    // Non-Director: effective ceiling is (10 - 2) = $8.00 = 8,000,000 micros.
    const { role: empRole, employee } = makeEmployeeWithTinyTaskBudget(
      null as unknown as number,
      false,
    );
    const empTask = insertTask(db, {
      project_id: project.id,
      title: 'T1',
      body: 'x',
      acceptance_criteria: ['done'],
    });
    const empAdapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        turnCompletedEvent(0, 8_500_000), // over the carved-out $8.00 ceiling, under the full $10.00
      ],
    });
    const empSupervisor = new Supervisor(employee.id, { db, activityLog, adapter: empAdapter });
    await empSupervisor.assign(makeCtx(empRole, employee, empTask));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(getEmployeeById(db, employee.id)?.status).toBe('parked'); // stopped short of the full budget
    const entries = readActivityLogLines() as Array<{
      type: string;
      employee_id: string | null;
      payload: unknown;
    }>;
    const exceeded = entries.find(
      (e) => e.type === 'employee.budget_exceeded' && e.employee_id === employee.id,
    );
    expect(exceeded?.payload).toEqual({ level: 'project' });
  });
});
