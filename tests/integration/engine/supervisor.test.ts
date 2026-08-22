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

  describe('max_turns inference — structured (native turn.completed) vs PTY (idle transition), same scenario', () => {
    it('structured mode counts one turn.completed as one turn', async () => {
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

    it('PTY mode infers one turn from a working -> idle transition, with no turn.completed event at all', async () => {
      const { role, employee } = makeEmployee({ engine_options: { mode: 'pty' } });
      const adapter = new FakeAdapter({
        events: [
          { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
          { t: 'turn.started', turnIndex: 0 }, // -> working
          { t: 'text.delta', text: 'hi' },
          { t: 'idle' }, // the only signal PTY mode has — working -> idle counts as one turn
        ],
      });
      const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
      await supervisor.assign(makeCtx(role, employee, tmpDir));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The identical logical scenario (one exchange) counts identically
      // across modes — the whole point of the inference rule.
      expect(supervisor.turnsCompleted).toBe(1);
    });

    it('an idle event with no prior working state does not count as a turn (e.g. immediately after session.started)', async () => {
      const { role, employee } = makeEmployee({ engine_options: { mode: 'pty' } });
      const adapter = new FakeAdapter({
        events: [
          { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
          { t: 'idle' }, // never did any work — not a completed turn
        ],
      });
      const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
      await supervisor.assign(makeCtx(role, employee, tmpDir));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(supervisor.turnsCompleted).toBe(0);
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
    const { role, employee } = makeEmployee({ engine_options: { mode: 'pty' } });
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
});
