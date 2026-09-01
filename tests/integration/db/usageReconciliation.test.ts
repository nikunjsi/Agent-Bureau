import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { reconcile } from '../../../src/main/db/reconcile';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { nowIso } from '../../../src/shared/models/ids';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertTask } from '../../../src/main/db/repositories/tasks';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee } from '../../../src/main/db/repositories/employees';
import { insertUsage } from '../../../src/main/db/repositories/usage';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §11.5.1: "A reconciliation check recomputes [the three denormalised spend
 * counters] from `usage` on startup and logs any drift." This is that
 * demonstration, not just an assertion of the mechanism's existence: a
 * counter is deliberately corrupted OUTSIDE the write path (direct SQL —
 * simulating manual DB surgery, a bug in an earlier version, or a partial
 * backup restore, none of which go through `insertUsage`'s own transaction),
 * then `reconcile()` (the real startup entry point) is called and the drift
 * is shown corrected with a real `cost.counter_drift_repaired` event
 * carrying the true before/after.
 */
describe('reconcileUsageCounters — startup drift detection and repair (§11.5.1)', () => {
  let tmpDir: string;
  let dbPath: string;
  let activityLogPath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-usage-reconcile-'));
    dbPath = path.join(tmpDir, 'bureau.db');
    activityLogPath = path.join(tmpDir, 'activity.jsonl');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    activityLog = ActivityLog.open(activityLogPath, db);
    const now = nowIso();
    db.prepare('INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(
      'dept1', 'engineering', 'Engineering', '{}', now, now,
    );
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

  function seed() {
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
    // The real ledger truth: exactly one 5000-micro turn, written through
    // the real transactional write path so all three counters start in
    // genuine agreement with it.
    insertUsage(
      db,
      { employee_id: employee.id, task_id: task.id, engine: 'claude-code', model: 'm', cost_usd_micros: 5000, source: 'turn' },
      { projectId: project.id },
    );
    return { employee, project, task };
  }

  it('detects and repairs task/project/employee counter drift on reconcile(), logging real before/after — the demonstration', async () => {
    const { employee, project, task } = seed();

    // Deliberately corrupt all three counters directly, bypassing
    // insertUsage entirely — exactly the class of drift the write path's
    // own transaction cannot see or prevent.
    db.prepare('UPDATE tasks SET spend_usd_micros = ? WHERE id = ?').run(999_000, task.id);
    db.prepare('UPDATE projects SET spend_usd_micros = ? WHERE id = ?').run(999_000, project.id);
    db.prepare('UPDATE employees SET lifetime_spend_usd_micros = ? WHERE id = ?').run(999_000, employee.id);

    const report = await reconcile(db, activityLog, tmpDir);

    // Real output: the drift count returned by reconcile() itself.
    expect(report.usageCountersDrifted).toBe(3);

    const taskRow = db.prepare('SELECT spend_usd_micros FROM tasks WHERE id = ?').get(task.id) as { spend_usd_micros: number };
    const projectRow = db.prepare('SELECT spend_usd_micros FROM projects WHERE id = ?').get(project.id) as { spend_usd_micros: number };
    const employeeRow = db.prepare('SELECT lifetime_spend_usd_micros FROM employees WHERE id = ?').get(employee.id) as {
      lifetime_spend_usd_micros: number;
    };
    expect(taskRow.spend_usd_micros).toBe(5000);
    expect(projectRow.spend_usd_micros).toBe(5000);
    expect(employeeRow.lifetime_spend_usd_micros).toBe(5000);

    const entries = readActivityLogLines() as Array<{
      type: string;
      payload: { table: string; id: string; beforeMicros: number; afterMicros: number } | null;
    }>;
    const driftEvents = entries.filter((e) => e.type === 'cost.counter_drift_repaired');
    expect(driftEvents, JSON.stringify(entries)).toHaveLength(3);

    const taskDrift = driftEvents.find((e) => e.payload?.table === 'tasks');
    expect(taskDrift?.payload).toEqual({ table: 'tasks', id: task.id, beforeMicros: 999_000, afterMicros: 5000 });
    const projectDrift = driftEvents.find((e) => e.payload?.table === 'projects');
    expect(projectDrift?.payload).toEqual({ table: 'projects', id: project.id, beforeMicros: 999_000, afterMicros: 5000 });
    const employeeDrift = driftEvents.find((e) => e.payload?.table === 'employees');
    expect(employeeDrift?.payload).toEqual({ table: 'employees', id: employee.id, beforeMicros: 999_000, afterMicros: 5000 });

    // Folded into the summary event too, matching every other reconcile
    // step's own pattern.
    const summary = entries.find((e) => e.type === 'app.reconciled') as { payload: { usageCountersDrifted: number } } | undefined;
    expect(summary?.payload.usageCountersDrifted).toBe(3);
  });

  it('does nothing and reports zero drift when every counter already agrees with the ledger', async () => {
    seed();
    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.usageCountersDrifted).toBe(0);
    const entries = readActivityLogLines() as Array<{ type: string }>;
    expect(entries.filter((e) => e.type === 'cost.counter_drift_repaired')).toHaveLength(0);
  });

  it('a Director-attributed usage row (no task_id, real project_id) is still caught by project-level reconciliation — the gap an id-through-tasks join would have missed', async () => {
    const role = insertRole(db, {
      key: 'director',
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Director',
      description: 'Directs',
      system_prompt_path: 'prompts/director.md',
      skills: [],
      deliverable_types: [],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: ['role'],
      autonomy_default: 'guided',
      sprite_key: 'dir',
    } as never);
    const director = insertEmployee(db, {
      name: 'Director',
      role_key: role.full_key,
      is_director: true,
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
      autonomy: 'autonomous',
      daily_budget_usd_micros: null,
      resume_at: null,
      heartbeat_at: null,
      consecutive_failures: 0,
      lifetime_spend_usd_micros: 0,
    } as never);
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    // No task_id at all — the Director's own usage shape.
    insertUsage(
      db,
      { employee_id: director.id, task_id: null, engine: 'claude-code', model: 'm', cost_usd_micros: 3000, source: 'turn' },
      { projectId: project.id },
    );

    db.prepare('UPDATE projects SET spend_usd_micros = ? WHERE id = ?').run(0, project.id);

    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.usageCountersDrifted).toBeGreaterThanOrEqual(1);
    const projectRow = db.prepare('SELECT spend_usd_micros FROM projects WHERE id = ?').get(project.id) as { spend_usd_micros: number };
    expect(projectRow.spend_usd_micros).toBe(3000);
  });
});
