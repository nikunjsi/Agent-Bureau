import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { ActivityLog } from '../../src/main/db/activityLog';
import { nowIso } from '../../src/shared/models/ids';
import { insertRole } from '../../src/main/db/repositories/roles';
import { insertEmployee, getEmployeeById } from '../../src/main/db/repositories/employees';
import { Supervisor } from '../../src/main/engine/supervisor';
import { FakeAdapter } from '../../src/main/engine/fakeAdapter';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../src/shared/engine/seams';
import type { EmployeeContext } from '../../src/shared/engine/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §28 M3 step 7 build note / M3 session 2 prompt: "Supervisor concurrency
 * bugs — crossed event streams, shared ring buffers, races on the PATH
 * cache — only appear at N>1, and this is the cheapest place to find
 * them." Two FakeAdapter employees, overlapping lifecycles (both
 * `assign()`ed before either finishes), each asserting it receives only
 * its own events and writes only its own DB rows.
 */
describe('Two employees, simultaneously (§28 M3 concurrency check)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-two-employee-'));
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
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEmployee(name: string) {
    const role = insertRole(db, {
      key: `dev-${name}`,
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
      name,
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
    return { role, employee };
  }

  function ctxFor(
    role: ReturnType<typeof makeEmployee>['role'],
    employee: ReturnType<typeof makeEmployee>['employee'],
  ): EmployeeContext {
    return {
      employee,
      role,
      task: null,
      worktreePath: `C:\\fake\\worktree\\${employee.id}`,
      stateDir: `C:\\fake\\state\\${employee.id}`,
      baseDir: `C:\\fake\\state\\${employee.id}`,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };
  }

  it('two employees running at once each receive only their own events, and only their own DB rows change', async () => {
    const a = makeEmployee('Ravi');
    const b = makeEmployee('Meera');

    const adapterA = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 'sess-a', engineVersion: 'x', model: null },
        { t: 'turn.started', turnIndex: 0 },
        {
          t: 'turn.completed',
          turnIndex: 0,
          usage: {
            tokensIn: 1,
            tokensOut: 1,
            tokensCacheRead: 0,
            tokensCacheWrite: 0,
            model: 'm',
            costUsdMicros: 111,
          },
        },
        { t: 'finished', reason: 'completed', summary: null },
      ],
    });
    const adapterB = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 'sess-b', engineVersion: 'x', model: null },
        { t: 'turn.started', turnIndex: 0 },
        {
          t: 'turn.completed',
          turnIndex: 0,
          usage: {
            tokensIn: 2,
            tokensOut: 2,
            tokensCacheRead: 0,
            tokensCacheWrite: 0,
            model: 'm',
            costUsdMicros: 222,
          },
        },
        { t: 'finished', reason: 'completed', summary: null },
      ],
    });

    const supA = new Supervisor(a.employee.id, { db, activityLog, adapter: adapterA });
    const supB = new Supervisor(b.employee.id, { db, activityLog, adapter: adapterB });

    // Overlapping lifecycles — both assigned before either has necessarily
    // finished consuming its own event stream.
    await Promise.all([
      supA.assign(ctxFor(a.role, a.employee)),
      supB.assign(ctxFor(b.role, b.employee)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Each ended up in its own correct state, not each other's.
    expect(supA.currentState).toBe('blocked');
    expect(supB.currentState).toBe('blocked');
    expect(getEmployeeById(db, a.employee.id)?.status).toBe('blocked');
    expect(getEmployeeById(db, b.employee.id)?.status).toBe('blocked');

    // Usage rows: A's cost never crossed into B's row or vice versa.
    const usageA = db
      .prepare('SELECT * FROM usage WHERE employee_id = ?')
      .all(a.employee.id) as Array<{
      cost_usd_micros: number;
    }>;
    const usageB = db
      .prepare('SELECT * FROM usage WHERE employee_id = ?')
      .all(b.employee.id) as Array<{
      cost_usd_micros: number;
    }>;
    expect(usageA).toHaveLength(1);
    expect(usageB).toHaveLength(1);
    expect(usageA[0]?.cost_usd_micros).toBe(111);
    expect(usageB[0]?.cost_usd_micros).toBe(222);

    // Activity events: each employee's own started/idle/blocked trail is
    // tagged with its own employee_id only — no cross-contamination.
    const eventsForA = db
      .prepare('SELECT type FROM events WHERE employee_id = ?')
      .all(a.employee.id) as Array<{
      type: string;
    }>;
    const eventsForB = db
      .prepare('SELECT type FROM events WHERE employee_id = ?')
      .all(b.employee.id) as Array<{
      type: string;
    }>;
    expect(eventsForA.length).toBeGreaterThan(0);
    expect(eventsForB.length).toBeGreaterThan(0);
    // No row anywhere has a NULL/foreign employee_id mixing the two.
    const crossedRows = db
      .prepare('SELECT COUNT(*) as n FROM events WHERE employee_id NOT IN (?, ?)')
      .get(a.employee.id, b.employee.id) as { n: number };
    expect(crossedRows.n).toBe(0);

    expect(supervisorTurnCounts(supA, supB)).toEqual([1, 1]);
  });

  function supervisorTurnCounts(...supervisors: Supervisor[]): number[] {
    return supervisors.map((s) => s.turnsCompleted);
  }
});
