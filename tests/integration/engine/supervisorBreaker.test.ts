import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { nowIso, newId } from '../../../src/shared/models/ids';
import { insertRole } from '../../../src/main/db/repositories/roles';
import {
  insertEmployee,
  getEmployeeById,
  setEmployeeWorktree,
} from '../../../src/main/db/repositories/employees';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertWorktree } from '../../../src/main/db/repositories/worktrees';
import { insertTask, getTaskById } from '../../../src/main/db/repositories/tasks';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { createPolicyEvaluator } from '../../../src/main/controlChannel/policy/policyEvaluator';
import { STEER_MESSAGE } from '../../../src/main/engine/circuitBreaker';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';

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
    wall_clock_timeout_s: 2400,
    ...overrides,
  };
}

/**
 * §11.5, security test S8 (`breaker_trips_on_loop`): loop detection fires
 * AND constrains — asserted by the constraint actually blocking the next
 * tool call, not by an event being logged. Also covers the rest of item
 * 10: the §11.5-literal "no interrupt, skip the message" fallback, the
 * Director-never-stopped case, `breaker.hardStop`'s immediate kill, and
 * escalation to a real stop after `steerTimeoutS`.
 */
describe('Supervisor circuit breaker (§11.5, item 10, security test S8)', () => {
  let tmpDir: string;
  let activityLogPath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-supervisor-breaker-'));
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

  function makeEmployee(roleOverrides: Record<string, unknown> = {}, isDirector = false) {
    const role = insertRole(db, baseRoleInput(roleOverrides) as never);
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

  /** The policy layer's own `${worktree}` variable comes from the DB
   * (`contextBuilder.ts`'s `buildEmployeePolicyContext` reads
   * `employee.worktree_id` → `getWorktreeById`), not from the
   * `worktreePath` string threaded through `EmployeeContext` (that one
   * is the adapter's own cwd, a separate concern). A real policy check
   * against a path "inside the worktree" needs a real, DB-linked
   * worktree row — matching `tests/helpers/dbFixtures.ts`'s own
   * `seedEmployeeWithWorktree` pattern — or an unset `${worktree}`
   * matches nothing (§11.3) and every Write looks "outside" regardless
   * of the real path chosen. */
  function linkWorktree(employeeId: string, projectId: string, wtPath: string): void {
    const worktree = insertWorktree(db, {
      project_id: projectId,
      path: wtPath,
      branch: `bureau/${employeeId}`,
      base_commit: '0'.repeat(40),
      status: 'leased',
    });
    setEmployeeWorktree(db, employeeId, worktree.id);
  }

  function makeCtx(
    role: ReturnType<typeof makeEmployee>['role'],
    employee: ReturnType<typeof makeEmployee>['employee'],
    task: { id: string; project_id: string; body: string } | null,
    worktreePath: string,
  ): EmployeeContext {
    return {
      employee,
      role,
      task: task as never,
      worktreePath,
      stateDir: tmpDir,
      memoryPack: '',
      decisionLog: '',
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: 'ask',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };
  }

  it('S8: interrupt() is called, the steer message actually lands, and a subsequent real policy check for this employee now resolves to ask instead of allow', async () => {
    const wtPath = mkdtempSync(path.join(tmpDir, 'wt-'));
    const { role, employee } = makeEmployee();
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'T',
      body: 'x',
      acceptance_criteria: ['done'],
    });
    linkWorktree(employee.id, project.id, wtPath);

    const adapter = new FakeAdapter({
      capabilities: { interrupt: true }, // the PTY shape §11.5's own text describes for step 1
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
      ],
    });
    const supervisorRegistry = new SupervisorRegistry();
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter,
      supervisorRegistry,
    });
    supervisorRegistry.register(employee.id, supervisor);
    await supervisor.assign(makeCtx(role, employee, task, wtPath));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Before tripping: a real policy check for an in-workspace Write at
    // "guided" resolves 'allow' (§11.2's own table) — this is the
    // baseline the breaker's constraint is supposed to change.
    const evaluatePolicy = createPolicyEvaluator(db, tmpDir, supervisorRegistry);
    const insidePath = path.join(wtPath, 'file.txt');
    const before = await evaluatePolicy(
      { tool: 'Write', rawTool: 'Write', args: { file_path: insidePath }, preview: '' },
      employee.id,
    );
    expect(before.effect).toBe('allow');

    // Trip it — the real signal server.ts's own handlePolicyCheck would
    // send on loop detection.
    supervisor.noteLoopDetected();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // FakeAdapter's own interrupt() sets turnState back to 'idle'
    // directly (real, not simulated — §7.4's own "interrupt is allowed
    // mid-turn, ends the current generation" reduced to its actual
    // effect on turn state), so the steer message sent immediately after
    // delivers right away rather than queuing — this IS the landing
    // proof: `sentMessages` is FakeAdapter's own record of what it
    // actually received, not of what Supervisor merely attempted.
    expect(adapter.interruptCallCount).toBe(1);
    expect(adapter.sentMessages).toContainEqual({
      text: STEER_MESSAGE,
      kind: 'steer',
      delivery: 'immediate',
    });
    expect(supervisor.isBreakerConstrained()).toBe(true);

    // The actual proof S8 requires: the SAME kind of call, through the
    // REAL policy evaluator, now blocks.
    const after = await evaluatePolicy(
      { tool: 'Write', rawTool: 'Write', args: { file_path: insidePath }, preview: '' },
      employee.id,
    );
    expect(after.effect).toBe('ask');

    const entries = readActivityLogLines() as Array<{ type: string; employee_id: string | null }>;
    expect(
      entries.some((e) => e.type === 'cost.breaker_tripped' && e.employee_id === employee.id),
    ).toBe(true);
  });

  it("§11.5's own literal fallback: caps.interrupt=false skips the corrective message entirely (never sent late) but still constrains", async () => {
    const wtPath = mkdtempSync(path.join(tmpDir, 'wt-'));
    const { role, employee } = makeEmployee();
    const task = insertTask(db, {
      project_id: insertProject(db, { name: 'P', path: tmpDir, kind: 'software' }).id,
      title: 'T',
      body: 'x',
      acceptance_criteria: ['done'],
    });

    const adapter = new FakeAdapter({
      capabilities: { interrupt: false }, // claude-code's real, structured-mode shape
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, task, wtPath));
    await new Promise((resolve) => setTimeout(resolve, 80));

    supervisor.noteLoopDetected();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(adapter.interruptCallCount).toBe(0);
    expect(adapter.sentMessages.some((m) => m.text === STEER_MESSAGE)).toBe(false);
    expect(supervisor.isBreakerConstrained()).toBe(true);
  });

  it('mutation check: without noteLoopDetected() ever being called, the identical policy check stays allow — proves the constraint, not the scenario, causes the ask', async () => {
    const wtPath = mkdtempSync(path.join(tmpDir, 'wt-'));
    const { role, employee } = makeEmployee();
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'T',
      body: 'x',
      acceptance_criteria: ['done'],
    });
    linkWorktree(employee.id, project.id, wtPath);
    const adapter = new FakeAdapter({
      events: [{ t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' }],
    });
    const supervisorRegistry = new SupervisorRegistry();
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter,
      supervisorRegistry,
    });
    supervisorRegistry.register(employee.id, supervisor);
    await supervisor.assign(makeCtx(role, employee, task, wtPath));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const evaluatePolicy = createPolicyEvaluator(db, tmpDir, supervisorRegistry);
    const insidePath = path.join(wtPath, 'file.txt');
    const verdict = await evaluatePolicy(
      { tool: 'Write', rawTool: 'Write', args: { file_path: insidePath }, preview: '' },
      employee.id,
    );
    expect(verdict.effect).toBe('allow');
    expect(supervisor.isBreakerConstrained()).toBe(false);
  });

  it("the Director may be constrained but is never stopped by the breaker (the deadlock §8.0's own reasoning warns against)", async () => {
    const wtPath = mkdtempSync(path.join(tmpDir, 'wt-'));
    const { role, employee: director } = makeEmployee({}, true);
    const adapter = new FakeAdapter({
      capabilities: { interrupt: true },
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
      ],
    });
    const supervisor = new Supervisor(director.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, director, null, wtPath));
    await new Promise((resolve) => setTimeout(resolve, 50));

    supervisor.noteLoopDetected();
    await new Promise((resolve) => setTimeout(resolve, 300)); // well past a real steerTimeoutS would ever need

    expect(supervisor.isBreakerConstrained()).toBe(true);
    expect(supervisor.currentState).not.toBe('off');
    expect(getEmployeeById(db, director.id)?.status).not.toBe('off');
  });

  it('breaker.hardStop=true skips steering entirely and stops immediately — task blocked, a real blocker checkpoint raised', async () => {
    setSetting(db, 'breaker.hardStop', true);
    const wtPath = mkdtempSync(path.join(tmpDir, 'wt-'));
    const { role, employee } = makeEmployee();
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'T',
      body: 'x',
      acceptance_criteria: ['done'],
    });
    const adapter = new FakeAdapter({
      capabilities: { interrupt: true },
      events: [{ t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' }],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, task, wtPath));
    await new Promise((resolve) => setTimeout(resolve, 50));

    supervisor.noteLoopDetected();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Immediate kill — never went through steer (no interrupt(), no message).
    expect(adapter.interruptCallCount).toBe(0);
    expect(adapter.sentMessages.some((m) => m.text === STEER_MESSAGE)).toBe(false);
    expect(supervisor.currentState).toBe('off');
    expect(getEmployeeById(db, employee.id)?.status).toBe('off');
    expect(getTaskById(db, task.id)?.status).toBe('blocked');

    const checkpoint = db
      .prepare("SELECT * FROM checkpoints WHERE employee_id = ? AND type = 'blocker'")
      .get(employee.id) as { title: string; urgency: string } | undefined;
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.urgency).toBe('blocking');

    const entries = readActivityLogLines() as Array<{ type: string; employee_id: string | null }>;
    expect(
      entries.some((e) => e.type === 'employee.stopped' && e.employee_id === employee.id),
    ).toBe(true);
  });

  it('escalates to a real stop after steerTimeoutS with no improvement — task blocked, employee.stopped emitted', async () => {
    setSetting(db, 'breaker.steerTimeoutS', 0); // deterministic: escalates on the very next tick
    const wtPath = mkdtempSync(path.join(tmpDir, 'wt-'));
    const { role, employee } = makeEmployee();
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'T',
      body: 'x',
      acceptance_criteria: ['done'],
    });
    const adapter = new FakeAdapter({
      capabilities: { interrupt: false }, // isolates this test to the escalation path, not the steer/deliver one
      events: [{ t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' }],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, task, wtPath));
    await new Promise((resolve) => setTimeout(resolve, 50));

    supervisor.noteLoopDetected(); // 'repeated_tool_calls' always "still holds" (no live peek into the policy-layer detector) — escalates
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(supervisor.currentState).toBe('off');
    expect(getTaskById(db, task.id)?.status).toBe('blocked');
    const entries = readActivityLogLines() as Array<{ type: string; employee_id: string | null }>;
    expect(
      entries.some((e) => e.type === 'employee.stopped' && e.employee_id === employee.id),
    ).toBe(true);
  });
});
