import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newId, nowIso } from '../../src/shared/models/ids';
import { EmployeeSchema } from '../../src/shared/models/employee';
import { RoleSchema } from '../../src/shared/models/role';
import { FakeAdapter } from '../../src/main/engine/fakeAdapter';
import { checkEngineVersionDrift, TESTED_ENGINE_VERSIONS } from '../../src/main/engine/engineVersionDrift';
import { GenericPtyAdapter } from '../../src/main/engine/genericPtyAdapter';
import { ClaudeCodeAdapter } from '../../src/main/engine/claudeCodeAdapter';
import { noopSecretBroker, placeholderControlChannel, placeholderToolServer } from '../../src/shared/engine/seams';
import type { AgentEvent } from '../../src/shared/engine/events';
import type { EmployeeContext } from '../../src/shared/engine/types';

/**
 * §7.8 — the adapter contract suite, parameterised. §19.1: "contract/
 * every engine adapter, one suite (FakeAdapter always; real engines when
 * present)." FakeAdapter's own run of this suite is what CI actually
 * checks (§7.8: most of the suite must run offline and free). The real
 * ClaudeCodeAdapter's equivalent evidence for tests 1 (probe) and 8 (no
 * orphans) already exists from this session's own real, gated runs
 * (tests/integration/engine/claudeCodeAdapterProbe.test.ts;
 * tests/contract/realEngineSpawn.test.ts plus a live process-tree scan) —
 * not re-spent here a third time for the same evidence.
 */
function fakeCtx(overrides: Partial<EmployeeContext> = {}): EmployeeContext {
  const now = nowIso();
  const employee = EmployeeSchema.parse({
    id: newId(), name: 'Ravi', role_key: 'engineering:developer', is_director: 0, desk_x: 0, desk_y: 0,
    sprite_variant: 'a', status: 'idle', status_detail: null, engine: 'fake', engine_mode: null,
    engine_version: null, model: null, session_id: null, pid: null, process_start_time: null,
    worktree_id: null, current_task_id: null, autonomy: 'guided', autonomous_confirmed_at: null, daily_budget_usd_micros: null, escalate_when: '[]', reports: '{}',
    resume_at: null, heartbeat_at: null, consecutive_failures: 0, lifetime_spend_usd_micros: 0,
    hired_at: now, archived_at: null, created_at: now, updated_at: now,
  });
  const role = RoleSchema.parse({
    id: newId(), key: 'developer', full_key: 'engineering:developer', department_key: 'engineering',
    pack_id: 'engineering', priority: 50, version: '1.0.0', title: 'Developer', description: 'Writes code',
    system_prompt_path: 'prompts/developer.md', skills: '[]', deliverable_types: '[]', shared_prompts: '[]', input_types: '[]',
    engine_preference: '["claude-code"]', model_preference: null, tools_allow: '[]', tools_deny: '[]',
    network_allow: '[]', memory_scopes: '[]', memory_budget_tokens: 8000, autonomy_default: 'guided', max_turns: 40, max_attempts: 2,
    wall_clock_timeout_s: 2400, budget_usd_micros: null, escalate_when: '[]', reports: '{}', sprite_key: 'dev', role_options: '{}',
    engine_options: null, enabled: 1, created_at: now, updated_at: now,
  });
  return {
    employee, role, task: null, worktreePath: 'C:\\fake\\worktree', stateDir: 'C:\\fake\\state',
    memoryPack: '', decisionLog: '', toolServer: placeholderToolServer, controlChannel: placeholderControlChannel,
    broker: noopSecretBroker, effectiveAutonomy: 'ask',
    modelId: null, turnBudgetCapUsdMicros: null, ...overrides,
  };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('§7.8 adapter contract suite — FakeAdapter (always, offline, free)', () => {
  it('test 1: probe() returns within 5s and never throws', async () => {
    const adapter = new FakeAdapter();
    const start = Date.now();
    const result = await adapter.probe();
    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.installed).toBe(true);
  });

  it('test 2: capabilities are internally consistent (permissionCallback ⇒ structuredEvents)', () => {
    const adapter = new FakeAdapter();
    const caps = adapter.capabilities({} as never);
    expect(caps.permissionCallback && !caps.structuredEvents).toBe(false);
  });

  it('test 2b (§28 M6 item 4): every declared networkTool is classified as "network" in toolClasses — no adapter can declare a tool as a network tool without also classifying it as one', () => {
    for (const adapter of [new FakeAdapter(), new ClaudeCodeAdapter(), new GenericPtyAdapter()]) {
      const caps = adapter.capabilities({} as never);
      for (const tool of caps.networkTools) {
        expect(caps.toolClasses[tool], `${adapter.key}: "${tool}" is in networkTools but not classified "network"`).toBe('network');
      }
    }
  });

  it('test 3: start -> send -> events -> finished completes for a trivial prompt', async () => {
    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: null },
        { t: 'idle' },
        { t: 'text.delta', text: 'OK' },
        { t: 'finished', reason: 'completed', summary: null },
      ],
    });
    await adapter.start(fakeCtx());
    await adapter.send('hi', 'task');
    const events = await drain(adapter.events());
    expect(events.map((e) => e.t)).toEqual(['session.started', 'idle', 'text.delta', 'finished']);
  });

  describe('test 4: a denied tool call provably did not execute (filesystem sentinel)', () => {
    let tmpDir: string;

    it('deny never touches the sentinel', async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-contract-test4-'));
      const sentinelPath = path.join(tmpDir, 'sentinel.txt');
      const adapter = new FakeAdapter({
        events: [{ t: 'tool.requested', callId: 'c1', tool: 'Bash', rawTool: 'Bash', args: {}, preview: 'rm -rf /' }],
        toolSentinels: { c1: sentinelPath },
      });
      await drain(adapter.events());
      await adapter.applyVerdict('c1', { effect: 'deny', ruleId: 'r1', reason: 'test' });
      expect(existsSync(sentinelPath)).toBe(false);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('parallel allow-path run: the SAME setup with allow DOES touch it — proves the check is not a placebo', async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-contract-test4-allow-'));
      const sentinelPath = path.join(tmpDir, 'sentinel.txt');
      const adapter = new FakeAdapter({
        events: [{ t: 'tool.requested', callId: 'c1', tool: 'Bash', rawTool: 'Bash', args: {}, preview: 'rm -rf /' }],
        toolSentinels: { c1: sentinelPath },
      });
      await drain(adapter.events());
      await adapter.applyVerdict('c1', { effect: 'allow', ruleId: 'r1' });
      expect(existsSync(sentinelPath)).toBe(true);
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  it('test 5: a message sent mid-generation is not delivered until idle', async () => {
    const adapter = new FakeAdapter({
      events: [{ t: 'turn.started', turnIndex: 0 }, { t: 'text.delta', text: 'working' }, { t: 'idle' }],
    });
    await adapter.start(fakeCtx());
    const iterator = adapter.events()[Symbol.asyncIterator]();
    await iterator.next(); // turn.started -> generating
    await iterator.next(); // text.delta -> still generating

    await adapter.send('are you done?', 'message');
    expect(adapter.sentMessages).toEqual([]); // not delivered yet

    await iterator.next(); // idle -> flush
    expect(adapter.sentMessages).toEqual([{ text: 'are you done?', kind: 'message', delivery: 'flushed-on-idle' }]);
  });

  it('test 6: interrupt() resolves promptly, or the adapter declares interrupt:false', async () => {
    const adapter = new FakeAdapter();
    const caps = adapter.capabilities({} as never);
    if (caps.interrupt) {
      const start = Date.now();
      await adapter.interrupt();
      expect(Date.now() - start).toBeLessThan(2000);
    } else {
      expect(caps.interrupt).toBe(false);
    }
  });

  it('test 7: resume() works or returns false — never hangs', async () => {
    const adapter = new FakeAdapter({ resumeResults: { 's1': true } });
    await expect(Promise.race([
      adapter.resume('s1', fakeCtx()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 2000)),
    ])).resolves.toBe(true);
    await expect(adapter.resume('unknown', fakeCtx())).resolves.toBe(false);
  });

  it('test 8: clean stop leaves no orphan processes (FakeAdapter spawns none — the real claim is ClaudeCodeAdapter\'s, evidenced separately this session by a live process-tree scan)', async () => {
    const adapter = new FakeAdapter();
    await adapter.start(fakeCtx());
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(adapter.wasStopped).toBe(true);
  });

  describe('test 9: a canary secret in the environment never appears in any emitted event', () => {
    const CANARY = 'sk-canary-CHANGEME-0001';

    /**
     * A small interface, not a call to the scanner directly (session 1's
     * approved plan) — at M6, the real redactor drops in here unchanged.
     */
    interface SecretScanner {
      scan(events: AgentEvent[], secret: string): boolean; // true = found (bad)
    }
    const inlineScanner: SecretScanner = {
      scan(events, secret) {
        return events.some((e) => JSON.stringify(e).includes(secret));
      },
    };

    it('a clean scripted run never leaks the canary', async () => {
      const adapter = new FakeAdapter({
        events: [
          { t: 'tool.requested', callId: 'c1', tool: 'Bash', rawTool: 'Bash', args: {}, preview: 'echo hello' },
        ],
      });
      const events = await drain(adapter.events());
      expect(inlineScanner.scan(events, CANARY)).toBe(false);
    });

    it('self-check: a deliberately-leaky fixture IS caught — proves the scanner is not a placebo', async () => {
      const adapter = new FakeAdapter({
        events: [
          { t: 'tool.requested', callId: 'c1', tool: 'Bash', rawTool: 'Bash', args: {}, preview: `echo ${CANARY}` },
        ],
      });
      const events = await drain(adapter.events());
      expect(inlineScanner.scan(events, CANARY)).toBe(true);
    });
  });

  /**
   * AUDIT #6: this test used to declare its own `checkVersionDrift`
   * INSIDE the `it()` body and assert against that — so it passed while
   * no drift detection existed anywhere in `src/` and
   * `employee.engine_version_drift` was emitted by nothing. It now
   * asserts against the real `checkEngineVersionDrift`, and
   * `supervisorVersionDrift.test.ts` covers the event actually being
   * emitted by a real Supervisor.
   *
   * Still honestly uncovered: §7.8 test 10's "and shows an 'untested
   * version' badge" half. There is no UI to show a badge in (M9/M13), so
   * that clause is not claimed here.
   */
  it('test 10: version drift outside the tested range is detected by the real detector (pinned to 2.1.238)', () => {
    expect(TESTED_ENGINE_VERSIONS['claude-code']).toContain('2.1.238');

    expect(checkEngineVersionDrift('claude-code', '2.1.238')).toBeNull();
    expect(checkEngineVersionDrift('claude-code', '2.2.0')).toMatchObject({
      engineKey: 'claude-code',
      reportedVersion: '2.2.0',
    });
    expect(checkEngineVersionDrift('claude-code', '2.1.100')).not.toBeNull();

    // No pin for an engine means nothing can drift, and a null version is
    // "the engine told us nothing", not drift — inventing drift for either
    // would make the signal meaningless.
    expect(checkEngineVersionDrift('generic-pty', '9.9.9')).toBeNull();
    expect(checkEngineVersionDrift('claude-code', null)).toBeNull();
  });
});

describe('§7.4 turn-boundary queue — dedicated (delivery order + nothing arrives early)', () => {
  it('multiple sends mid-generation queue in order and all flush together on the next idle, none early', async () => {
    const adapter = new FakeAdapter({
      events: [{ t: 'turn.started', turnIndex: 0 }, { t: 'text.delta', text: 'thinking' }, { t: 'idle' }],
    });
    await adapter.start(fakeCtx());
    const iterator = adapter.events()[Symbol.asyncIterator]();
    await iterator.next(); // -> generating
    await iterator.next(); // still generating

    await adapter.send('first', 'message');
    expect(adapter.sentMessages).toEqual([]); // nothing arrived early
    await adapter.send('second', 'message');
    expect(adapter.sentMessages).toEqual([]); // still nothing — second queued too

    await iterator.next(); // idle -> flush
    expect(adapter.sentMessages).toEqual([
      { text: 'first', kind: 'message', delivery: 'flushed-on-idle' },
      { text: 'second', kind: 'message', delivery: 'flushed-on-idle' },
    ]);
  });

  it('a send while already idle delivers immediately, not queued', async () => {
    const adapter = new FakeAdapter();
    await adapter.start(fakeCtx());
    await adapter.send('go', 'task');
    expect(adapter.sentMessages).toEqual([{ text: 'go', kind: 'task', delivery: 'immediate' }]);
  });
});

/**
 * §7.7.1 REJECTED a PTY semantic parser, permanently — so "full content-level
 * parity" is not a temporary gap to close later, it is never going to be
 * true, and a test that stayed `it.skip` forever would just rot (M3 session
 * 3 correction). What IS real and permanent: both modes share one lifecycle
 * backbone (`session.started -> turn.started -> idle -> finished`, same
 * order) — structured additionally carries content (`text.delta`,
 * `tool.requested`, ...) and usage (`turn.completed`); PTY additionally
 * carries `raw`. That is the actual invariant, checked here for real,
 * not assumed.
 */
describe('mode-parity — the real, permanent invariant (M3 session 3 correction)', () => {
  const LIFECYCLE_TYPES = new Set(['session.started', 'turn.started', 'idle', 'finished']);

  it('structured and PTY scenarios differ in their mode-specific extras, but share an identical lifecycle backbone', async () => {
    // Deliberately NOT the same array reused for both — that would prove
    // nothing about real adapters. Each is shaped like what that mode's
    // real ClaudeCodeAdapter actually interleaves around the shared
    // lifecycle events: structured gets content + turn.completed(usage);
    // PTY gets raw bytes instead.
    const structuredScenario: AgentEvent[] = [
      { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
      { t: 'turn.started', turnIndex: 0 },
      { t: 'text.delta', text: 'working on it' },
      { t: 'tool.requested', callId: 'c1', tool: 'Read', rawTool: 'Read', args: {}, preview: 'x.ts' },
      { t: 'tool.completed', callId: 'c1', ok: true, excerpt: '', ms: 5 },
      {
        t: 'turn.completed',
        turnIndex: 0,
        usage: { tokensIn: 1, tokensOut: 1, tokensCacheRead: 0, tokensCacheWrite: 0, model: 'm', costUsdMicros: 10 },
      },
      { t: 'idle' },
      { t: 'finished', reason: 'completed', summary: null },
    ];
    const ptyScenario: AgentEvent[] = [
      { t: 'session.started', sessionId: null, engineVersion: 'x', model: null },
      { t: 'turn.started', turnIndex: 0 },
      { t: 'raw', data: Buffer.from('some terminal bytes', 'utf8') },
      { t: 'idle' },
      { t: 'finished', reason: 'completed', summary: null },
    ];

    const structured = await drain(new FakeAdapter({ events: structuredScenario }).events());
    const pty = await drain(new FakeAdapter({ events: ptyScenario }).events());

    const structuredLifecycle = structured.filter((e) => LIFECYCLE_TYPES.has(e.t)).map((e) => e.t);
    const ptyLifecycle = pty.filter((e) => LIFECYCLE_TYPES.has(e.t)).map((e) => e.t);
    expect(structuredLifecycle).toEqual(['session.started', 'turn.started', 'idle', 'finished']);
    expect(ptyLifecycle).toEqual(structuredLifecycle); // the actual invariant

    // And the mode-specific extras really are mode-specific, not a fluke of
    // the fixtures above — this is what §7.7.1 says PTY does NOT get.
    expect(structured.some((e) => e.t === 'text.delta' || e.t === 'tool.requested' || e.t === 'turn.completed')).toBe(true);
    expect(pty.some((e) => e.t === 'text.delta' || e.t === 'tool.requested' || e.t === 'turn.completed')).toBe(false);
    expect(pty.some((e) => e.t === 'raw')).toBe(true);
  });

  /**
   * The real-adapter leg. Note what changed the shape of this since it was
   * written: claude-code is structured-only now (§7.7.1 correction 3 —
   * PTY-for-claude-code was rejected, not deferred), so no single real
   * adapter has both modes to compare against itself anymore. What's
   * actually being proven is stronger, not weaker: that the shared
   * lifecycle backbone holds *across two different real adapters* —
   * ClaudeCodeAdapter's real structured events (this is what its
   * capabilities(probe, 'structured') and buildLaunchSpec() actually
   * produce, exercised via FakeAdapter scripted to the identical shape
   * real spawns are proven to emit elsewhere, tests/unit/engine/
   * claudeCodeStreamJson.test.ts — not re-spent here as a real spawn) and
   * GenericPtyAdapter's real pty events, spawning the real scripted local
   * CLI (tests/helpers/scriptedPtyCli.cjs) through the real onReady wiring
   * — zero cost, fully deterministic, no engine installed required.
   */
  it('same invariant against a real adapter\'s actual pty output (GenericPtyAdapter + the scripted local CLI), not scripted fixtures on both sides', async () => {
    const scriptPath = path.resolve('tests/helpers/scriptedPtyCli.cjs');

    const structuredScenario: AgentEvent[] = [
      { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
      { t: 'turn.started', turnIndex: 0 },
      { t: 'text.delta', text: 'working on it' },
      { t: 'turn.completed', turnIndex: 0, usage: null },
      { t: 'idle' },
      { t: 'finished', reason: 'completed', summary: null },
    ];
    const structured = await drain(new FakeAdapter({ events: structuredScenario }).events());

    const now = nowIso();
    const employee = EmployeeSchema.parse({
      id: newId(), name: 'Ravi', role_key: 'engineering:scripted-cli', is_director: 0, desk_x: 0, desk_y: 0,
      sprite_variant: 'a', status: 'idle', status_detail: null, engine: 'generic-pty', engine_mode: null,
      engine_version: null, model: null, session_id: null, pid: null, process_start_time: null,
      worktree_id: null, current_task_id: null, autonomy: 'ask', autonomous_confirmed_at: null, daily_budget_usd_micros: null, escalate_when: '[]', reports: '{}',
      resume_at: null, heartbeat_at: null, consecutive_failures: 0, lifetime_spend_usd_micros: 0,
      hired_at: now, archived_at: null, created_at: now, updated_at: now,
    });
    const role = RoleSchema.parse({
      id: newId(), key: 'scripted-cli', full_key: 'engineering:scripted-cli', department_key: 'engineering',
      pack_id: 'engineering', priority: 50, version: '1.0.0', title: 'Scripted CLI', description: 'test target',
      system_prompt_path: 'prompts/scripted-cli.md', skills: '[]', deliverable_types: '[]', shared_prompts: '[]', input_types: '[]',
      engine_preference: '["generic-pty"]', model_preference: null, tools_allow: '[]', tools_deny: '[]',
      network_allow: '[]', memory_scopes: '[]', memory_budget_tokens: 8000, autonomy_default: 'ask', max_turns: 10, max_attempts: 1,
      wall_clock_timeout_s: 60, budget_usd_micros: null, escalate_when: '[]', reports: '{}', sprite_key: 'dev', role_options: '{}',
      engine_options: JSON.stringify({
        mode: 'pty', command: process.execPath, args: [scriptPath],
        ready_pattern: '(?:^|\\r|\\n)>[^\\r\\n]*$', done_pattern: '^\\[done\\]',
        interrupt: '\x03', ready_debounce_ms: 100,
      }),
      enabled: 1, created_at: now, updated_at: now,
    });
    const ptyCtx: EmployeeContext = {
      employee, role, task: null, worktreePath: process.cwd(), stateDir: process.cwd(),
      memoryPack: '', decisionLog: '', toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel, broker: noopSecretBroker, effectiveAutonomy: 'ask',
      modelId: null, turnBudgetCapUsdMicros: null,
    };
    const ptyAdapter = new GenericPtyAdapter();
    await ptyAdapter.start(ptyCtx);
    const ptyIterator = ptyAdapter.events()[Symbol.asyncIterator]();
    const pty: AgentEvent[] = [];
    await ptyAdapter.send('hello', 'task');
    for (;;) {
      const { value } = await ptyIterator.next();
      pty.push(value);
      if (value.t === 'idle') break; // one full turn's lifecycle proven; stop before a second round-trip
    }
    await ptyAdapter.stop();

    const structuredLifecycle = structured.filter((e) => LIFECYCLE_TYPES.has(e.t)).map((e) => e.t);
    const ptyLifecycle = pty.filter((e) => LIFECYCLE_TYPES.has(e.t)).map((e) => e.t);
    expect(ptyLifecycle).toEqual(['session.started', 'turn.started', 'idle']); // no finished yet — session still open
    expect(structuredLifecycle.slice(0, 3)).toEqual(ptyLifecycle); // shared prefix — the actual invariant
    expect(pty.some((e) => e.t === 'raw')).toBe(true);
    expect(pty.some((e) => e.t === 'text.delta' || e.t === 'tool.requested' || e.t === 'turn.completed')).toBe(false);
  }, 15_000);
});
