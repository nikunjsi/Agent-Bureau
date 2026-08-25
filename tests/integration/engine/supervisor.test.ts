import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { noopSecretBroker, placeholderControlChannel, placeholderToolServer } from '../../../src/shared/engine/seams';
import type { EngineAdapter } from '../../../src/shared/engine/adapter';
import type { AgentEvent, SendKind } from '../../../src/shared/engine/events';
import type { EmployeeContext, EngineCapabilities, LaunchSpec, ProbeResult } from '../../../src/shared/engine/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * A minimal, directly-controllable EngineAdapter double, used only for the
 * heartbeat tests. FakeAdapter's finite scripted-event model represents
 * "the conversation ended" once exhausted, not "silent but still
 * connected" — heartbeat testing needs precisely the latter, with
 * lastActivityAt() controllable independent of event delivery.
 */
class HangingAdapter implements EngineAdapter {
  readonly key = 'hanging-test-double';
  readonly supportedModes: ReadonlySet<'structured' | 'pty'> = new Set(['structured']);
  private activityAt = Date.now();
  private readonly waiters: Array<(v: IteratorResult<AgentEvent>) => void> = [];

  async probe(): Promise<ProbeResult> {
    return { installed: true, authenticated: true, version: null, binaryPath: null, error: null, metered: true };
  }
  capabilities(): EngineCapabilities {
    return {
      structuredEvents: true,
      permissionCallback: false,
      hookInterception: false,
      sessionResume: false,
      interrupt: false,
      usageReporting: false,
      mcpServers: false,
      modelSelection: false,
      maxContextTokens: null,
      promptCaching: false,
    };
  }
  async buildLaunchSpec(ctx: EmployeeContext): Promise<LaunchSpec> {
    return { command: 'fake', args: [], cwd: ctx.worktreePath, env: { FAKE_KEY: '1' }, configFiles: [] };
  }
  async start(): Promise<void> {}
  async send(_text: string, _kind: SendKind): Promise<void> {}
  async *events(): AsyncIterable<AgentEvent> {
    yield { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: null };
    yield { t: 'turn.started', turnIndex: 0 };
    // Then hang forever without completing — exactly "silent, still
    // connected", never delivering `done: true`.
    for (;;) {
      const value = await new Promise<IteratorResult<AgentEvent>>((resolve) => this.waiters.push(resolve));
      yield value.value;
    }
  }
  async applyVerdict(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
  async resume(): Promise<boolean> {
    return false;
  }
  lastActivityAt(): number {
    return this.activityAt;
  }
  /** Test-only: simulate a real chunk of activity without ending the stream. */
  touch(): void {
    this.activityAt = Date.now();
  }
}

/** A double whose events() throws immediately — for the consecutive_failures/backoff test. */
class CrashingAdapter extends HangingAdapter {
  override async *events(): AsyncIterable<AgentEvent> {
    throw new Error('simulated crash');
    // Unreachable — require-yield needs a yield present in a generator
    // body; this line never actually runs, matching intent exactly (the
    // whole point is that this adapter never yields anything, only throws).
    yield { t: 'idle' };
  }
}

/**
 * §7.7.1/M3 session 3 correction 3: claude-code is structured-only now —
 * insertRole rejects mode:'pty' for it. These tests exercise Supervisor's
 * PTY-mode handling (mode-agnostic — it only reads role.engine_options,
 * never cares which real adapter it's paired with; FakeAdapter is used
 * throughout regardless), so they need a role whose *schema* actually
 * permits mode:'pty' — generic-pty — not a real generic-pty adapter.
 */
function ptyRoleOverrides(extra: Record<string, unknown> = {}) {
  return {
    engine_preference: ['generic-pty'],
    engine_options: { mode: 'pty', command: 'fake-cli', ready_pattern: '^> $' },
    ...extra,
  };
}

function baseRoleInput(overrides: Record<string, unknown> = {}) {
  return {
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
    engine_options: null,
    ...overrides,
  };
}

describe('Supervisor (§7.11)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-supervisor-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    const now = nowIso();
    db.prepare('INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(
      'dept1', 'engineering', 'Engineering', '{}', now, now,
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEmployee(roleOverrides: Record<string, unknown> = {}, consecutiveFailures = 0) {
    const role = insertRole(db, baseRoleInput(roleOverrides) as never);
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
      consecutive_failures: consecutiveFailures,
      lifetime_spend_usd_micros: 0,
    } as never);
    return { role, employee };
  }

  function makeCtx(role: ReturnType<typeof makeEmployee>['role'], employee: ReturnType<typeof makeEmployee>['employee'], worktreePath: string): EmployeeContext {
    return {
      employee,
      role,
      task: null,
      worktreePath,
      stateDir: worktreePath,
      memoryPack: '',
      decisionLog: '',
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: 'ask',
    };
  }

  it('state machine: starting -> idle -> working -> (finished, no bureau_task_done) -> blocked', async () => {
    const { role, employee } = makeEmployee();
    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        { t: 'text.delta', text: 'hi' },
        { t: 'finished', reason: 'completed', summary: null },
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    const ctx = makeCtx(role, employee, tmpDir);

    expect(supervisor.currentState).toBe('off');
    await supervisor.assign(ctx);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the supervisor's own background consumeEvents() catch up

    expect(supervisor.currentState).toBe('blocked'); // ended_without_report — bureau_task_done doesn't exist yet (M4)
    expect(getEmployeeById(db, employee.id)?.status).toBe('blocked');

    const blockedEvent = db.prepare("SELECT payload FROM events WHERE type = 'employee.blocked'").get() as
      | { payload: string | null }
      | undefined;
    expect(blockedEvent, 'expected exactly one employee.blocked event').toBeDefined();
    expect(JSON.parse(blockedEvent?.payload ?? 'null')).toEqual({ reason: 'ended_without_report' });
    // No second, differently-typed event for the *same* transition
    // (CLAUDE.md invariant #3) — a prior version of this code additionally
    // emitted a stray 'employee.idle' carrying the ended_without_report
    // reason even though the employee was transitioning to 'blocked', not
    // idle. A real, earlier 'employee.idle' from session.started is
    // expected and fine; what must never happen is *this* reason turning
    // up on that (or any) event typed 'employee.idle'.
    const idleEventsWithBlockedReason = db
      .prepare("SELECT id FROM events WHERE type = 'employee.idle' AND payload LIKE '%ended_without_report%'")
      .all();
    expect(idleEventsWithBlockedReason).toEqual([]);
  });

  it('state machine: bureau_task_done reported before finished -> idle, task_reported (M4 session 2 gap closed)', async () => {
    const { role, employee } = makeEmployee();
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
        { t: 'text.delta', text: 'hi' },
        { t: 'finished', reason: 'completed', summary: null },
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    const ctx: EmployeeContext = { ...makeCtx(role, employee, tmpDir), task };

    await supervisor.assign(ctx);
    // Simulate the control channel's bureau_task_done handler calling this
    // directly (via SupervisorRegistry, tested separately) — synchronously,
    // as it would be, before the adapter's own event stream reaches
    // 'finished' (FakeAdapter delivers its scripted events asynchronously,
    // so this ordering is realistic, not contrived).
    supervisor.noteTaskDone(task.id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(supervisor.currentState).toBe('idle'); // NOT blocked — the report won the race
    expect(getEmployeeById(db, employee.id)?.status).toBe('idle');
    // The *latest* employee.idle event, not just any — session.started
    // earlier in this same sequence also transitions through idle with a
    // null payload, which is legitimate and not what this assertion is
    // checking.
    const idleEvent = db.prepare("SELECT payload FROM events WHERE type = 'employee.idle' ORDER BY seq DESC LIMIT 1").get() as
      | { payload: string | null }
      | undefined;
    expect(idleEvent, 'expected an employee.idle event').toBeDefined();
    expect(JSON.parse(idleEvent?.payload ?? 'null')).toEqual({ reason: 'task_reported' });
  });

  it('records the launch activity event with base env KEYS only, never values', async () => {
    const { role, employee } = makeEmployee();
    // HangingAdapter's buildLaunchSpec() returns a real env with a real
    // key+value ({ FAKE_KEY: '1' }) — needed here specifically to prove
    // the value never leaks, which a plain FakeAdapter's empty default env
    // can't demonstrate either way.
    const adapter = new HangingAdapter();
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, tmpDir));
    await supervisor.stop();

    const rows = db.prepare("SELECT * FROM events WHERE type = 'employee.started'").all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as { envKeys: string[] };
    expect(payload.envKeys).toEqual(['FAKE_KEY']);
    // Never a value, anywhere in the logged payload.
    expect(JSON.stringify(payload)).not.toContain('"1"');
  });

  it('consecutive_failures persists across a simulated restart — backoff does not reset to 0', async () => {
    const { role, employee } = makeEmployee({}, 3); // pre-seeded, simulating a prior session's failures

    // A new Supervisor instance (simulating a fresh process after a
    // restart) reads the persisted count at assign() time, then a crash
    // (adapter.events() throwing) should increment from 3, not from 0.
    const crashingAdapter = new CrashingAdapter();
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter: crashingAdapter });
    await supervisor.assign(makeCtx(role, employee, tmpDir));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getEmployeeById(db, employee.id)?.consecutive_failures).toBe(4);
  });

  it('writes a real usage row (source=turn) when turn.completed carries usage — structured mode', async () => {
    const { role, employee } = makeEmployee({ engine_options: { mode: 'structured' } });
    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 }, // real structured-mode conversations always get this before turn.completed (§7.11 correction 2 counts here, not on turn.completed)
        {
          t: 'turn.completed',
          turnIndex: 0,
          usage: {
            tokensIn: 10,
            tokensOut: 5,
            tokensCacheRead: 0,
            tokensCacheWrite: 0,
            model: 'claude-haiku-4-5-20251001',
            costUsdMicros: 1234,
          },
        },
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, tmpDir));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = db.prepare('SELECT * FROM usage WHERE employee_id = ?').all(employee.id) as Array<{
      source: string;
      cost_usd_micros: number;
      tokens_in: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'turn', cost_usd_micros: 1234, tokens_in: 10 });
    expect(supervisor.turnsCompleted).toBe(1);
  });

  describe('turn counting — one mode-symmetric mechanism (§7.11 M3 session 3 correction 2)', () => {
    // Session 2 built two separate mechanisms (structured: count on
    // turn.completed; PTY: infer from a working->idle transition) that were
    // free to disagree. Replaced with one rule, counting on turn.started —
    // real in structured mode (parsed from the SDK stream), adapter
    // bookkeeping in PTY mode (§7.7.1) — so a scenario scripted identically
    // in both modes counts identically by construction, not by coincidence.
    it('structured mode: counts turn.started, not turn.completed', async () => {
      const { role, employee } = makeEmployee({ engine_options: { mode: 'structured' } });
      const adapter = new FakeAdapter({
        events: [
          { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
          { t: 'turn.started', turnIndex: 0 },
          { t: 'text.delta', text: 'hi' },
          { t: 'turn.completed', turnIndex: 0, usage: null },
        ],
      });
      const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
      await supervisor.assign(makeCtx(role, employee, tmpDir));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(supervisor.turnsCompleted).toBe(1);
    });

    it('PTY mode: counts the exact same event type (turn.started), identical scenario counts identically', async () => {
      const { role, employee } = makeEmployee(ptyRoleOverrides());
      const adapter = new FakeAdapter({
        events: [
          { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
          { t: 'turn.started', turnIndex: 0 }, // PTY's own adapter-level bookkeeping, real ClaudeCodeAdapter emits this at the actual write (§7.7.1)
          { t: 'idle' },
        ],
      });
      const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
      await supervisor.assign(makeCtx(role, employee, tmpDir));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Not "coincidentally the same number" — the identical code path.
      expect(supervisor.turnsCompleted).toBe(1);
    });

    it('turn.completed alone, with no turn.started, does not count — regression guard against re-introducing a second counting site', async () => {
      const { role, employee } = makeEmployee({ engine_options: { mode: 'structured' } });
      const adapter = new FakeAdapter({
        events: [
          { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
          { t: 'turn.completed', turnIndex: 0, usage: null },
        ],
      });
      const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
      await supervisor.assign(makeCtx(role, employee, tmpDir));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(supervisor.turnsCompleted).toBe(0);
    });

    it('an idle event, alone, does not count — idle is no longer a counting signal at all', async () => {
      const { role, employee } = makeEmployee(ptyRoleOverrides());
      const adapter = new FakeAdapter({
        events: [
          { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
          { t: 'idle' },
        ],
      });
      const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
      await supervisor.assign(makeCtx(role, employee, tmpDir));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(supervisor.turnsCompleted).toBe(0);
    });

    it('two turn.started events count as two turns, in either mode', async () => {
      const { role, employee } = makeEmployee({ engine_options: { mode: 'structured' } });
      const adapter = new FakeAdapter({
        events: [
          { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
          { t: 'turn.started', turnIndex: 0 },
          { t: 'turn.completed', turnIndex: 0, usage: null },
          { t: 'turn.started', turnIndex: 1 },
          { t: 'turn.completed', turnIndex: 1, usage: null },
        ],
      });
      const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
      await supervisor.assign(makeCtx(role, employee, tmpDir));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(supervisor.turnsCompleted).toBe(2);
    });
  });

  describe('heartbeat — must distinguish slow-but-alive from genuinely hung', () => {
    it('slow but alive (activity within the timeout window) survives — never transitions to failed', async () => {
      const { role, employee } = makeEmployee();
      const adapter = new HangingAdapter();
      const supervisor = new Supervisor(employee.id, {
        db,
        activityLog,
        adapter,
        heartbeat: { structuredTimeoutMs: 300 },
        heartbeatCheckIntervalMs: 50,
      });
      await supervisor.assign(makeCtx(role, employee, tmpDir));

      // Touch activity every 100ms for 400ms total — always well within
      // the 300ms timeout at check time.
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        adapter.touch();
      }
      expect(supervisor.currentState).not.toBe('failed');
      await supervisor.stop();
    });

    it('genuinely hung (no activity at all) is detected and transitions to failed', async () => {
      const { role, employee } = makeEmployee();
      const adapter = new HangingAdapter();
      const supervisor = new Supervisor(employee.id, {
        db,
        activityLog,
        adapter,
        heartbeat: { structuredTimeoutMs: 150 },
        heartbeatCheckIntervalMs: 50,
      });
      await supervisor.assign(makeCtx(role, employee, tmpDir));

      // No .touch() calls at all — genuine silence.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(supervisor.currentState).toBe('failed');
      const rows = db.prepare("SELECT * FROM events WHERE type = 'employee.heartbeat_missed'").all();
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it('stop() transitions off and stops the heartbeat monitor', async () => {
    const { role, employee } = makeEmployee();
    const adapter = new FakeAdapter({ events: [] });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, tmpDir));
    await supervisor.stop();
    expect(supervisor.currentState).toBe('off');
    expect(getEmployeeById(db, employee.id)?.status).toBe('off');
  });

  it('routes PTY raw output through the injected TranscriptWriter interface (the M6 redaction seam)', async () => {
    const { role, employee } = makeEmployee(ptyRoleOverrides());
    const written: Array<{ employeeId: string; chunk: string }> = [];
    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: null },
        { t: 'raw', data: Buffer.from('hello from the terminal', 'utf8') },
      ],
    });
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter,
      transcriptWriter: {
        async write(employeeId, chunk) {
          written.push({ employeeId, chunk });
        },
      },
    });
    await supervisor.assign(makeCtx(role, employee, tmpDir));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(written).toEqual([{ employeeId: employee.id, chunk: 'hello from the terminal' }]);
  });

  it('raw PTY output also reaches the owned TerminalBroadcaster (§17.1 M3 step 8), same bytes as the transcript writer', async () => {
    const { role, employee } = makeEmployee(ptyRoleOverrides());
    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: null },
        { t: 'raw', data: Buffer.from('xterm sees this too', 'utf8') },
      ],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter, terminalBroadcaster: { coalesceMs: 1 } });
    const received: string[] = [];
    supervisor.terminal.attach((chunk) => received.push(Buffer.from(chunk.base64, 'base64').toString('utf8')));

    await supervisor.assign(makeCtx(role, employee, tmpDir));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toEqual(['xterm sees this too']);
  });

  it('takeControl grants write access, interrupt()s first (§14.5), and sendControlInput reaches the adapter — release restores read-only', async () => {
    const { role, employee } = makeEmployee(ptyRoleOverrides());
    let interrupted = false;
    const adapter = new FakeAdapter({ events: [{ t: 'session.started', sessionId: 's1', engineVersion: 'x', model: null }] });
    const originalInterrupt = adapter.interrupt.bind(adapter);
    adapter.interrupt = async () => {
      interrupted = true;
      return originalInterrupt();
    };
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(makeCtx(role, employee, tmpDir));

    // Read-only by default — before takeControl, input is refused.
    expect(supervisor.sendControlInput('window-1', 'should not land')).toBe(false);

    const granted = await supervisor.takeControl('window-1');
    expect(granted).toBe(true);
    expect(interrupted).toBe(true);

    expect(supervisor.sendControlInput('window-1', 'ls\r')).toBe(true);
    expect(adapter.sentMessages).toEqual([{ text: 'ls\r', kind: 'user', delivery: 'immediate' }]);

    supervisor.releaseControl('window-1');
    expect(supervisor.sendControlInput('window-1', 'blocked again')).toBe(false);
  });
});
