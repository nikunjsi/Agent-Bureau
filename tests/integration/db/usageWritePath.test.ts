import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { nowIso } from '../../../src/shared/models/ids';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertTask } from '../../../src/main/db/repositories/tasks';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee } from '../../../src/main/db/repositories/employees';
import { insertUsage, getUsageById, getUsageSince } from '../../../src/main/db/repositories/usage';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §11.5.1's own literal SQL: ONE BEGIN IMMEDIATE transaction inserting into
 * `usage` and updating all three denormalised counters — "therefore never
 * disagree." Before M6 session 2, `insertUsage` was a bare INSERT with no
 * counter updates at all; this is that gap, closed, and this is the test
 * that proves the counters actually move together with the ledger row.
 */
describe('insertUsage — the transactional write path (§11.5.1)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-usage-write-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    const now = nowIso();
    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', '{}', now, now);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEmployeeAndTask() {
    const role = insertRole(db, {
      key: 'developer',
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
    } as never);
    const employee = insertEmployee(db, {
      name: 'Ravi',
      role_key: role.full_key,
      is_director: false,
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
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'A task',
      body: 'Do the thing.',
      acceptance_criteria: ['done'],
    });
    return { employee, project, task };
  }

  it('inserts the usage row and moves all three denormalised counters in the same transaction', () => {
    const { employee, project, task } = makeEmployeeAndTask();

    const result = insertUsage(
      db,
      {
        employee_id: employee.id,
        task_id: task.id,
        engine: 'claude-code',
        model: 'claude-sonnet-5',
        tokens_in: 1000,
        tokens_out: 500,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        cost_usd_micros: 7270,
        computed_cost_usd_micros: 7270,
        turn_index: 0,
        source: 'turn',
      },
      { projectId: project.id },
    );

    expect(result.usage.cost_usd_micros).toBe(7270);
    expect(result.usage.project_id).toBe(project.id);
    expect(result.taskSpend).toEqual({ beforeMicros: 0, afterMicros: 7270 });
    expect(result.projectSpend).toEqual({ beforeMicros: 0, afterMicros: 7270 });
    expect(result.employeeLifetimeSpend).toEqual({ beforeMicros: 0, afterMicros: 7270 });

    const taskRow = db.prepare('SELECT spend_usd_micros FROM tasks WHERE id = ?').get(task.id) as {
      spend_usd_micros: number;
    };
    const projectRow = db
      .prepare('SELECT spend_usd_micros FROM projects WHERE id = ?')
      .get(project.id) as { spend_usd_micros: number };
    const employeeRow = db
      .prepare('SELECT lifetime_spend_usd_micros FROM employees WHERE id = ?')
      .get(employee.id) as {
      lifetime_spend_usd_micros: number;
    };
    expect(taskRow.spend_usd_micros).toBe(7270);
    expect(projectRow.spend_usd_micros).toBe(7270);
    expect(employeeRow.lifetime_spend_usd_micros).toBe(7270);
  });

  it('accumulates correctly across multiple turns — before/after brackets exactly the new increment each time', () => {
    const { employee, project, task } = makeEmployeeAndTask();
    const first = insertUsage(
      db,
      {
        employee_id: employee.id,
        task_id: task.id,
        engine: 'claude-code',
        model: 'm',
        cost_usd_micros: 1000,
        source: 'turn',
      },
      { projectId: project.id },
    );
    const second = insertUsage(
      db,
      {
        employee_id: employee.id,
        task_id: task.id,
        engine: 'claude-code',
        model: 'm',
        cost_usd_micros: 2500,
        source: 'turn',
      },
      { projectId: project.id },
    );

    expect(first.taskSpend).toEqual({ beforeMicros: 0, afterMicros: 1000 });
    expect(second.taskSpend).toEqual({ beforeMicros: 1000, afterMicros: 3500 });

    const taskRow = db.prepare('SELECT spend_usd_micros FROM tasks WHERE id = ?').get(task.id) as {
      spend_usd_micros: number;
    };
    expect(taskRow.spend_usd_micros).toBe(3500);
  });

  it("stores computed_cost_usd_micros independently of cost_usd_micros — the engine-reported figure never discards Bureau's own estimate", () => {
    const { employee, project, task } = makeEmployeeAndTask();
    const result = insertUsage(
      db,
      {
        employee_id: employee.id,
        task_id: task.id,
        engine: 'claude-code',
        model: 'claude-sonnet-5',
        cost_usd_micros: 9000, // engine-reported, authoritative
        computed_cost_usd_micros: 7270, // Bureau's own estimate — disagrees, but kept, not discarded
        source: 'turn',
      },
      { projectId: project.id },
    );
    expect(result.usage.cost_usd_micros).toBe(9000);
    expect(result.usage.computed_cost_usd_micros).toBe(7270);
    // The counter that drives budget enforcement uses the authoritative
    // figure only — the losing estimate never leaks into it.
    const taskRow = db.prepare('SELECT spend_usd_micros FROM tasks WHERE id = ?').get(task.id) as {
      spend_usd_micros: number;
    };
    expect(taskRow.spend_usd_micros).toBe(9000);
  });

  it('a null cost_usd_micros ("cost not reported", §21) contributes zero to every counter, and stays null in storage — never a fabricated $0', () => {
    const { employee, project, task } = makeEmployeeAndTask();
    const result = insertUsage(
      db,
      {
        employee_id: employee.id,
        task_id: task.id,
        engine: 'generic-pty',
        model: null,
        cost_usd_micros: null,
        source: 'turn',
      },
      { projectId: project.id },
    );
    expect(result.usage.cost_usd_micros).toBeNull();
    expect(result.taskSpend).toEqual({ beforeMicros: 0, afterMicros: 0 });

    const stored = getUsageById(db, result.usage.id);
    expect(stored?.cost_usd_micros).toBeNull();
  });

  it('the Director case — no task_id, only a project attribution — updates projects and employees but skips the tasks UPDATE entirely', () => {
    const { employee, project } = makeEmployeeAndTask();
    const result = insertUsage(
      db,
      {
        employee_id: employee.id,
        task_id: null,
        engine: 'claude-code',
        model: 'm',
        cost_usd_micros: 4000,
        source: 'turn',
      },
      { projectId: project.id },
    );
    expect(result.taskSpend).toBeNull();
    expect(result.projectSpend).toEqual({ beforeMicros: 0, afterMicros: 4000 });
    expect(result.usage.task_id).toBeNull();
    expect(result.usage.project_id).toBe(project.id);

    const projectRow = db
      .prepare('SELECT spend_usd_micros FROM projects WHERE id = ?')
      .get(project.id) as { spend_usd_micros: number };
    expect(projectRow.spend_usd_micros).toBe(4000);
  });

  it('getUsageSince sums real ledger cost from a given instant, 0 (a real result) for no matching rows — not "cost not reported"', () => {
    const { employee, project, task } = makeEmployeeAndTask();
    const before = nowIso();
    expect(getUsageSince(db, before, { employeeId: employee.id })).toBe(0);

    insertUsage(
      db,
      {
        employee_id: employee.id,
        task_id: task.id,
        engine: 'claude-code',
        model: 'm',
        cost_usd_micros: 1500,
        source: 'turn',
      },
      { projectId: project.id },
    );
    expect(getUsageSince(db, before, { employeeId: employee.id })).toBe(1500);
    expect(getUsageSince(db, before)).toBe(1500);

    // A cutoff after this row's own timestamp sees nothing yet.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(getUsageSince(db, future, { employeeId: employee.id })).toBe(0);
  });
});
