import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { newId, nowIso } from '../../../src/shared/models/ids';
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

/**
 * §11.5 / AUDIT #8 — "parked" has to be a GATE, not a status label.
 *
 * `applyBudgetVerdict` set `transition('parked')` and nothing else for the
 * default `budgets.onExceed: park`: the adapter was never stopped or
 * interrupted, `transition()` had no terminal-state guard, and
 * `case 'turn.started'` transitioned to `'working'` unconditionally. So an
 * employee that had already blown its budget would silently resume and
 * keep spending if its adapter emitted another turn — and `enforceBudget`
 * would not re-fire, because the threshold check only triggers on the
 * turn that CROSSES the limit.
 *
 * Nothing drives further turns today (no Director until M11), which is why
 * this was latent rather than live. But PROJECT-CHECKLIST's v1
 * definition-of-done row 6 claims "budgets and circuit breaker provably
 * stop a runaway employee", and S7's own "stays stopped" proof pushes a
 * `turn.completed`, never a `turn.started` — so the one event that would
 * have exposed it was the one never sent.
 *
 * **N-1 (pre-M11):** the gate gates *state transitions*, not *accounting*.
 * The first version returned before every event, `turn.completed` included,
 * and this file asserted that as success ("the second turn must not have been
 * billed"). But claude-code cannot be interrupted, so a turn the engine really
 * finishes after a park or a pause really costs money, and dropping its usage
 * under-counts the ledger, the counters and every budget level. The money
 * assertion is now that the turn IS recorded, and the gate is asserted
 * directly: no `employee.working` ever follows `employee.parked`.
 */
describe('S7 budget_stops_runaway: a parked employee cannot start another turn (AUDIT #8)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-parkgate-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
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

  function eventTypes(): string[] {
    return readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { type: string }).type);
  }

  function usage(turnIndex: number, costUsdMicros: number): AgentEvent {
    return {
      t: 'turn.completed',
      turnIndex,
      usage: {
        tokensIn: 100,
        tokensOut: 50,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        model: 'm',
        costUsdMicros,
      },
    };
  }

  it('a turn.started after a budget park does NOT return the employee to working, but the turn the engine really ran is billed', async () => {
    setSetting(db, 'budgets.onExceed', 'park');

    const role = insertRole(db, {
      key: `developer-${newId()}`,
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes code',
      system_prompt_path: 'prompts/developer.md',
      skills: [],
      deliverable_types: [],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: [],
      autonomy_default: 'guided',
      sprite_key: 'dev',
      budget_usd_micros: 1_000, // tiny — the first turn blows it
    } as never);
    const employee = insertEmployee(db, {
      name: `Ravi-${newId()}`,
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'off',
      engine: 'claude-code',
      autonomy: 'guided',
    } as never);
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
        usage(0, 5_000), // crosses the 1_000-micro task budget -> park
        // The event S7 never sends: the adapter tries to start ANOTHER
        // turn after the park. A status label lets this through.
        { t: 'turn.started', turnIndex: 1 },
        { t: 'text.delta', text: 'still generating after the budget was blown' },
        usage(1, 5_000),
      ],
    });

    const ctx: EmployeeContext = {
      employee,
      role,
      task: task as never,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };

    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(ctx);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const finalStatus = getEmployeeById(db, employee.id)?.status;
    expect(finalStatus, 'a parked employee must not be back at work').toBe('parked');
    expect(
      supervisor.currentState,
      'the supervisor itself must still consider this employee parked',
    ).toBe('parked');

    // The money question (N-1): the engine really ran turn 1, so it is billed.
    const billedTurns = (
      db.prepare('SELECT turn_index FROM usage ORDER BY turn_index').all() as Array<{
        turn_index: number;
      }>
    ).map((r) => r.turn_index);
    expect(billedTurns, 'a turn the engine really ran went unrecorded').toEqual([0, 1]);

    // The gate itself (M10′): nothing moves a parked employee back to work.
    const types = eventTypes();
    const parkedAt = types.indexOf('employee.parked');
    expect(parkedAt).toBeGreaterThanOrEqual(0);
    expect(
      types.slice(parkedAt).includes('employee.working'),
      `employee.working after employee.parked: ${types.slice(parkedAt).join(' > ')}`,
    ).toBe(false);
  });

  it('park stops the adapter — the process is not left running after the budget is blown', async () => {
    setSetting(db, 'budgets.onExceed', 'park');

    const role = insertRole(db, {
      key: `developer-${newId()}`,
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes code',
      system_prompt_path: 'prompts/developer.md',
      skills: [],
      deliverable_types: [],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: [],
      autonomy_default: 'guided',
      sprite_key: 'dev',
      budget_usd_micros: 1_000,
    } as never);
    const employee = insertEmployee(db, {
      name: `Ravi-${newId()}`,
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'off',
      engine: 'claude-code',
      autonomy: 'guided',
    } as never);
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
        usage(0, 5_000),
      ],
    });

    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign({
      employee,
      role,
      task: task as never,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(getEmployeeById(db, employee.id)?.status).toBe('parked');
    // §11.5's "park" has to end the generation, not just relabel the row —
    // otherwise the engine keeps burning tokens Bureau has already decided
    // it will not pay for.
    expect(
      adapter.interruptCallCount > 0 || adapter.wasStopped,
      'park left the adapter running',
    ).toBe(true);
  });

  it("N-1: a user pause mid-turn on an engine that cannot be interrupted still records that turn's spend", async () => {
    const role = insertRole(db, {
      key: `developer-${newId()}`,
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes code',
      system_prompt_path: 'prompts/developer.md',
      skills: [],
      deliverable_types: [],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: [],
      autonomy_default: 'guided',
      sprite_key: 'dev',
      budget_usd_micros: null,
    } as never);
    const employee = insertEmployee(db, {
      name: `Ravi-${newId()}`,
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'off',
      engine: 'claude-code',
      autonomy: 'guided',
    } as never);
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'A task',
      body: 'Do the thing.',
      acceptance_criteria: ['done'],
    });

    // claude-code's real structured-mode shape: no interrupt.
    const adapter = new FakeAdapter({
      keepOpen: true,
      capabilities: { interrupt: false },
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign({
      employee,
      role,
      task: task as never,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(supervisor.currentState).toBe('working');

    await supervisor.pause();
    expect(adapter.interruptCallCount).toBe(0);
    // The engine finishes the turn it was already running.
    adapter.pushEvent({ t: 'text.delta', text: 'finishing the in-flight turn' });
    adapter.pushEvent(usage(0, 250_000));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(supervisor.currentState).toBe('parked');
    const rows = db.prepare('SELECT cost_usd_micros FROM usage').all();
    expect(rows).toEqual([{ cost_usd_micros: 250_000 }]);
    expect(getEmployeeById(db, employee.id)?.lifetime_spend_usd_micros).toBe(250_000);
    const types = eventTypes();
    expect(types.slice(types.indexOf('employee.parked'))).toContain('cost.turn_recorded');
    expect(types.slice(types.indexOf('employee.parked'))).not.toContain('employee.working');
    await supervisor.stop();
  });
});
