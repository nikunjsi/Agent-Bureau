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
    ...overrides,
  };
}

/**
 * §24.3, security-relevant behavior (item 9): a rate limit must never look
 * like a crash, per-minute backs off and retries, per-day parks with a
 * real resume_at and a real information checkpoint, and (§24.3's own
 * asymmetric-cost correction from this session's review) an ambiguous
 * classification defaults to the recoverable direction.
 */
describe('Supervisor rate-limit handling (§24.3, item 9)', () => {
  let tmpDir: string;
  let activityLogPath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-supervisor-ratelimit-'));
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
    const role = insertRole(db, baseRoleInput() as never);
    const employee = insertEmployee(db, {
      name: `Ravi-${newId()}`,
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

  it('per-minute: status becomes "waiting" (not "thinking"/"failed"), emits employee.rate_limited, and retries by resending the original task body', async () => {
    const { role, employee } = makeEmployee();
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'T',
      body: 'Do the real thing.',
      acceptance_criteria: ['done'],
    });

    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        { t: 'rate_limited', classification: 'per_minute', retryAfterMs: null } as AgentEvent,
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, task));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(supervisor.currentState).toBe('waiting');
    expect(getEmployeeById(db, employee.id)?.status).toBe('waiting');

    const entries = readActivityLogLines() as Array<{ type: string; employee_id: string | null }>;
    expect(
      entries.some((e) => e.type === 'employee.rate_limited' && e.employee_id === employee.id),
    ).toBe(true);
    expect(entries.some((e) => e.type === 'employee.failed')).toBe(false);
    expect(entries.some((e) => e.type === 'employee.crashed')).toBe(false);
    expect(getEmployeeById(db, employee.id)?.consecutive_failures).toBe(0);

    // The real retry: after the (real, ~2s) backoff delay, adapter.send()
    // is called again with the SAME content originally sent at assign().
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(adapter.sentMessages).toEqual([
      { text: 'Do the real thing.', kind: 'task', delivery: 'immediate' },
      { text: 'Do the real thing.', kind: 'task', delivery: 'immediate' },
    ]);
  }, 15_000);

  it('a rate-limited turn is never treated as a crash — a "finished/error" immediately after does not fail the employee', async () => {
    const { role, employee } = makeEmployee();
    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        { t: 'rate_limited', classification: 'per_minute', retryAfterMs: null } as AgentEvent,
        { t: 'finished', reason: 'error', summary: null },
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, null));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(supervisor.currentState).not.toBe('failed');
    expect(getEmployeeById(db, employee.id)?.consecutive_failures).toBe(0);
    const entries = readActivityLogLines() as Array<{ type: string }>;
    expect(entries.some((e) => e.type === 'employee.crashed')).toBe(false);
  });

  it('per-minute escalates to exhausted (parked) once engines.rateLimitMaxWaitMinutes has elapsed — never retries forever', async () => {
    setSetting(db, 'engines.rateLimitMaxWaitMinutes', 0); // deterministic: elapsed(~0ms) >= maxWait(0ms) on the very first occurrence
    const { role, employee } = makeEmployee();
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'T',
      body: 'x',
      acceptance_criteria: ['done'],
    });

    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        { t: 'rate_limited', classification: 'per_minute', retryAfterMs: null } as AgentEvent,
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, task));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(supervisor.currentState).toBe('parked');
    const employeeRow = getEmployeeById(db, employee.id);
    expect(employeeRow?.status).toBe('parked');
    expect(employeeRow?.resume_at).toBeTruthy();

    const entries = readActivityLogLines() as Array<{ type: string; employee_id: string | null }>;
    expect(
      entries.some((e) => e.type === 'employee.quota_exhausted' && e.employee_id === employee.id),
    ).toBe(true);

    const taskRow = db
      .prepare('SELECT status, status_reason FROM tasks WHERE id = ?')
      .get(task.id) as {
      status: string;
      status_reason: string | null;
    };
    expect(taskRow.status).toBe('blocked');
    expect(taskRow.status_reason).toBe('quota_exhausted');
  });

  it('per-day: parks immediately, sets resume_at, blocks the task, and raises a real information checkpoint with the exact §24.3 template', async () => {
    const { role, employee } = makeEmployee();
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'T',
      body: 'x',
      acceptance_criteria: ['done'],
    });

    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        { t: 'rate_limited', classification: 'per_day', retryAfterMs: null } as AgentEvent,
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, task));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(supervisor.currentState).toBe('parked');
    const employeeRow = getEmployeeById(db, employee.id);
    expect(employeeRow?.status).toBe('parked');
    expect(employeeRow?.resume_at).toBeTruthy();
    // Never a fabricated known time for an engine whose pricing.yaml
    // carries no `pricing` at all in this test (Supervisor constructed
    // with no `pricing` option) — the honest now+1h fallback.
    const resumeAtMs = new Date(employeeRow!.resume_at as unknown as string).getTime();
    expect(resumeAtMs).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(resumeAtMs).toBeLessThan(Date.now() + 65 * 60_000);

    const taskRow = db
      .prepare('SELECT status, status_reason FROM tasks WHERE id = ?')
      .get(task.id) as {
      status: string;
      status_reason: string | null;
    };
    expect(taskRow.status).toBe('blocked');
    expect(taskRow.status_reason).toBe('quota_exhausted');

    const checkpointRow = db
      .prepare("SELECT * FROM checkpoints WHERE employee_id = ? AND type = 'information'")
      .get(employee.id) as { context: string; urgency: string; options: string | null } | undefined;
    expect(checkpointRow).toBeDefined();
    expect(checkpointRow?.context).toBe(
      "We've used up today's free quota for fake. Work is paused and will resume automatically when we retry in an hour. You can also connect a paid key in Settings to continue now.",
    );
    expect(checkpointRow?.options).toBeNull();

    const entries = readActivityLogLines() as Array<{ type: string; employee_id: string | null }>;
    expect(
      entries.some((e) => e.type === 'employee.quota_exhausted' && e.employee_id === employee.id),
    ).toBe(true);
  });

  it('stop() cancels a pending rate-limit retry timer — no send() reaches a torn-down adapter', async () => {
    const { role, employee } = makeEmployee();
    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        { t: 'rate_limited', classification: 'per_minute', retryAfterMs: null } as AgentEvent,
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, null));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(supervisor.currentState).toBe('waiting');

    await supervisor.stop();
    const sentAtStop = adapter.sentMessages.length;

    // Long enough that, had the retry timer NOT been cancelled, it would
    // have fired by now (attempt 0's backoff is ~2s).
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(adapter.sentMessages.length).toBe(sentAtStop);
  }, 15_000);
});
