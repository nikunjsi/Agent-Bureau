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
import { setSetting } from '../../../src/main/db/repositories/settings';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import { canEnableZeroCostMode } from '../../../src/main/cost/zeroCostMode';
import type { EmployeeContext } from '../../../src/shared/engine/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('canEnableZeroCostMode — claude-code branch, a real probe (§24.5)', () => {
  it('exercises the real probe() + switch branch on this machine and returns a well-formed, self-consistent result', async () => {
    // Environment-tolerant by design: this machine's real `claude auth
    // status` may or may not be metered/installed, and `probe()` is a real
    // ~5s-bounded subprocess spawn (§7.1) — two independent calls to it in
    // the same test are not guaranteed to agree if one happens to hit the
    // timeout fallback and the other doesn't (found while writing this
    // test: comparing against a second, separately-taken probe was flaky
    // for exactly that reason). This asserts the one real call's own
    // internal consistency instead — a real exercise of the dynamic
    // import + subprocess path, not a fixed allowed/refused outcome.
    const result = await canEnableZeroCostMode('claude-code');
    expect(typeof result.allowed).toBe('boolean');
    expect(result.reason).toBeTruthy();
    if (result.allowed) {
      expect(result.reason).toContain('subscription');
    } else {
      expect(result.reason).toMatch(/metered|not installed|not authenticated/i);
    }
  });
});

/**
 * §24.5: "employee spawn refused... emitting cost.zero_cost_blocked." Real
 * enforcement, not a seam — proven the sentinel-shaped way §7.8 test 4
 * proves non-execution: assert the adapter's own `start()` was never
 * called, not just that a function returned a refusal object.
 */
describe('Supervisor.assign() refuses a metered spawn when zero-cost mode is on (§24.5)', () => {
  let tmpDir: string;
  let activityLogPath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-zerocost-'));
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

  function makeEmployee() {
    const role = insertRole(db, {
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
    } as never);
    const employee = insertEmployee(db, {
      name: `Quinn-${newId()}`,
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

  function makeCtx(
    role: ReturnType<typeof makeEmployee>['role'],
    employee: ReturnType<typeof makeEmployee>['employee'],
  ): EmployeeContext {
    return {
      employee,
      role,
      task: null,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };
  }

  it('refuses to spawn, never calls adapter.start(), and emits cost.zero_cost_blocked', async () => {
    setSetting(db, 'costs.zeroCostMode', true);
    const { role, employee } = makeEmployee();
    const adapter = new FakeAdapter({ probeResult: { metered: true }, events: [] });
    let startCalled = false;
    const originalStart = adapter.start.bind(adapter);
    adapter.start = async (ctx) => {
      startCalled = true;
      return originalStart(ctx);
    };
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });

    await expect(supervisor.assign(makeCtx(role, employee))).rejects.toThrow(/zero-cost mode/i);

    expect(startCalled).toBe(false); // the real proof — no spawn happened
    expect(getEmployeeById(db, employee.id)?.status).toBe('off'); // never even reached 'starting'

    const entries = readActivityLogLines() as Array<{
      type: string;
      employee_id: string | null;
      severity: string;
    }>;
    const blockedEvent = entries.find(
      (e) => e.type === 'cost.zero_cost_blocked' && e.employee_id === employee.id,
    );
    expect(blockedEvent, JSON.stringify(entries)).toBeDefined();
    expect(blockedEvent?.severity).toBe('warn');
  });

  it('a non-metered engine spawns normally even with zero-cost mode on', async () => {
    setSetting(db, 'costs.zeroCostMode', true);
    const { role, employee } = makeEmployee();
    const adapter = new FakeAdapter({
      probeResult: { metered: false },
      events: [{ t: 'session.started', sessionId: 's1', engineVersion: 'x', model: null }],
    });
    let startCalled = false;
    const originalStart = adapter.start.bind(adapter);
    adapter.start = async (ctx) => {
      startCalled = true;
      return originalStart(ctx);
    };
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });

    await supervisor.assign(makeCtx(role, employee));
    expect(startCalled).toBe(true);

    const entries = readActivityLogLines() as Array<{ type: string }>;
    expect(entries.some((e) => e.type === 'cost.zero_cost_blocked')).toBe(false);
  });

  it('a metered engine spawns normally when zero-cost mode is off', async () => {
    setSetting(db, 'costs.zeroCostMode', false);
    const { role, employee } = makeEmployee();
    const adapter = new FakeAdapter({
      probeResult: { metered: true },
      events: [{ t: 'session.started', sessionId: 's1', engineVersion: 'x', model: null }],
    });
    let startCalled = false;
    const originalStart = adapter.start.bind(adapter);
    adapter.start = async (ctx) => {
      startCalled = true;
      return originalStart(ctx);
    };
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });

    await supervisor.assign(makeCtx(role, employee));
    expect(startCalled).toBe(true);
  });
});
