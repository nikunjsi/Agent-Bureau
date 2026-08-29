import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { EmployeeSchema } from '../../../src/shared/models/employee';
import { RoleSchema } from '../../../src/shared/models/role';
import { GenericPtyAdapter } from '../../../src/main/engine/genericPtyAdapter';
import { buildWindowsBaseEnv } from '../../../src/main/engine/windowsEnv';
import { noopSecretBroker, placeholderControlChannel, placeholderToolServer } from '../../../src/shared/engine/seams';
import type { AgentEvent } from '../../../src/shared/engine/events';
import type { EmployeeContext } from '../../../src/shared/engine/types';

/**
 * §7.7 generic-pty adapter, real — no FakeAdapter double, no claude-code,
 * no cost. Spawns tests/helpers/scriptedPtyCli.cjs, a deterministic local
 * Node script (fixed prompt, echo, exit keyword) via node-pty, exercising
 * the exact same PTY machinery a real wrapped agent would use — with real
 * onReady wiring, which ClaudeCodeAdapter's now-unreachable pty branch
 * never got (§7.7.1 M3 session 3 correction 3).
 *
 * The scripted CLI uses §7.7's own documented example patterns
 * (ready_pattern/done_pattern) as a starting point, with two real fixes
 * found by actually running them, not just reading them:
 *
 * 1. §7.7's YAML wrote `(?m)^> $` / `(?m)^\[done\]` — a PCRE/Python-style
 *    inline mode flag. JS RegExp has no such syntax; GenericPtyAdapter
 *    threw `SyntaxError: Invalid group` against its own documented example
 *    the first time it actually ran one. Fixed in the adapter (always
 *    applies the 'm' flag itself, never expects it in the pattern string)
 *    and in the spec — patterns here carry no `(?m)` prefix.
 * 2. The *ready* pattern still isn't the literal `^> $` even with that
 *    fixed: a real capture (this session's investigation) showed ConPTY
 *    rewrites a prompt's trailing space into a cursor-forward escape
 *    sequence (`\x1b[1C`) rather than emitting a literal space byte, so a
 *    pattern requiring one never matches real output.
 *    `(?:^|\r|\n)>[^\r\n]*$` (anchored on a `>` at a true line start,
 *    tolerant of whatever follows on that line) matches the real captured
 *    bytes and is what ships here — recorded so nobody rediscovers either
 *    of these the hard way.
 */
const SCRIPT_PATH = path.resolve('tests/helpers/scriptedPtyCli.cjs');
const READY_PATTERN = '(?:^|\\r|\\n)>[^\\r\\n]*$';
const DONE_PATTERN = '^\\[done\\]';

function fakeEmployeeContext(stateDir: string, worktreePath: string): EmployeeContext {
  const now = nowIso();
  const employee = EmployeeSchema.parse({
    id: newId(), name: 'Ravi', role_key: 'engineering:scripted-cli', is_director: 0, desk_x: 0, desk_y: 0,
    sprite_variant: 'a', status: 'idle', status_detail: null, engine: 'generic-pty', engine_mode: null,
    engine_version: null, model: null, session_id: null, pid: null, process_start_time: null,
    worktree_id: null, current_task_id: null, autonomy: 'ask', autonomous_confirmed_at: null, daily_budget_usd_micros: null,
    resume_at: null, heartbeat_at: null, consecutive_failures: 0, lifetime_spend_usd_micros: 0,
    hired_at: now, created_at: now, updated_at: now,
  });
  const role = RoleSchema.parse({
    id: newId(), key: 'scripted-cli', full_key: 'engineering:scripted-cli', department_key: 'engineering',
    pack_id: 'engineering', priority: 50, version: '1.0.0', title: 'Scripted CLI', description: 'test target',
    system_prompt_path: 'prompts/scripted-cli.md', skills: '[]', deliverable_types: '[]',
    engine_preference: '["generic-pty"]', model_preference: null, tools_allow: '[]', tools_deny: '[]',
    network_allow: '[]', memory_scopes: '[]', autonomy_default: 'ask', max_turns: 10, max_attempts: 1,
    wall_clock_timeout_s: 60, budget_usd_micros: null, sprite_key: 'dev', role_options: '{}',
    engine_options: JSON.stringify({
      mode: 'pty',
      command: process.execPath,
      args: [SCRIPT_PATH],
      ready_pattern: READY_PATTERN,
      done_pattern: DONE_PATTERN,
      interrupt: '\x03',
      ready_debounce_ms: 100,
    }),
    enabled: 1, created_at: now, updated_at: now,
  });
  return {
    employee, role, task: null, worktreePath, stateDir, memoryPack: '', decisionLog: '',
    toolServer: placeholderToolServer, controlChannel: placeholderControlChannel, broker: noopSecretBroker,
    effectiveAutonomy: 'ask',
  };
}

async function collectUntil(
  events: AsyncIterable<AgentEvent>,
  predicate: (e: AgentEvent) => boolean,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  const iterator = events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`collectUntil timed out; got so far: ${JSON.stringify(collected)}`);
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('per-event timeout')), remaining)),
    ]);
    if (result.done) break;
    collected.push(result.value);
    if (predicate(result.value)) break;
  }
  return collected;
}

describe('GenericPtyAdapter (§7.7) — real spawn, deterministic local CLI, zero cost', () => {
  let adapter: GenericPtyAdapter | null = null;

  afterEach(async () => {
    await adapter?.stop();
    adapter = null;
  });

  it('§7.8 test 3 shape: start -> send -> events -> finished, for a trivial exchange', async () => {
    adapter = new GenericPtyAdapter();
    const ctx = fakeEmployeeContext(process.cwd(), process.cwd());
    await adapter.start(ctx);

    const eventsPromise = collectUntil(adapter.events(), (e) => e.t === 'finished', 10_000);
    await adapter.send('hello', 'task');
    // idle fires after the echo; send exit to make the script announce done.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await adapter.send('exit', 'task');
    const events = await eventsPromise;

    expect(events.map((e) => e.t)).toContain('session.started');
    expect(events.map((e) => e.t)).toContain('turn.started');
    expect(events.map((e) => e.t)).toContain('idle');
    expect(events.some((e) => e.t === 'raw')).toBe(true);
    const finished = events.find((e) => e.t === 'finished');
    expect(finished).toMatchObject({ t: 'finished', reason: 'completed' });
  }, 15_000);

  it('onReady wiring: the turn-boundary queue actually flushes mid-session, not just once at process exit', async () => {
    adapter = new GenericPtyAdapter();
    const ctx = fakeEmployeeContext(process.cwd(), process.cwd());
    await adapter.start(ctx);

    const iterator = adapter.events()[Symbol.asyncIterator]();
    await adapter.send('first', 'task');
    // Wait for the real idle (ready-pattern match, debounced) rather than a fixed sleep guess.
    for (;;) {
      const { value } = await iterator.next();
      if (value.t === 'idle') break;
    }
    // A SECOND turn, in the SAME still-alive session — this is exactly what
    // ClaudeCodeAdapter's pty branch could never do (turnState stuck on
    // 'generating' forever after the first send, §7.11 correction 2's
    // motivating bug). Proving it here is the whole point of building
    // onReady wiring for real.
    await adapter.send('second', 'task');
    let sawSecondEcho = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value } = await iterator.next();
      if (value.t === 'raw' && value.data.toString('utf8').includes('echo: second')) {
        sawSecondEcho = true;
        break;
      }
    }
    expect(sawSecondEcho).toBe(true);
  }, 15_000);

  it('env isolation: the spawned process env is the restricted §7.6-style set, not process.env', async () => {
    process.env.BUREAU_CANARY_SHOULD_NOT_LEAK = 'canary-value';
    try {
      adapter = new GenericPtyAdapter();
      const ctx = fakeEmployeeContext(process.cwd(), process.cwd());
      const spec = await adapter.buildLaunchSpec(ctx);
      expect(spec.env.BUREAU_CANARY_SHOULD_NOT_LEAK).toBeUndefined();
      expect(spec.env.HOME).toBe(process.cwd());
      expect(spec.env.ComSpec).toBeTruthy(); // Windows base allowlist present
    } finally {
      delete process.env.BUREAU_CANARY_SHOULD_NOT_LEAK;
    }
  });

  it(
    '§11.7 S10: the built env is EXACTLY the expected closed set — no CLAUDECODE/CLAUDE_CODE_EXECPATH-family ' +
      'leak, no tolerance list needed (buildLaunchSpec() never spreads process.env — confirmed by reading the code)',
    async () => {
      adapter = new GenericPtyAdapter();
      const ctx = fakeEmployeeContext(process.cwd(), process.cwd());
      const spec = await adapter.buildLaunchSpec(ctx);

      const expectedKeys = new Set(['HOME', 'USERPROFILE', 'GIT_OPTIONAL_LOCKS', 'PATH', 'TEMP', 'TMP', ...Object.keys(buildWindowsBaseEnv())]);
      expect(new Set(Object.keys(spec.env))).toEqual(expectedKeys);
      expect(spec.env['CLAUDECODE']).toBeUndefined();
      expect(spec.env['CLAUDE_CODE_EXECPATH']).toBeUndefined();
    },
  );

  it('§7.8 test 7: resume() returns false, never hangs — no session id is ever captured in pty mode', async () => {
    adapter = new GenericPtyAdapter();
    await expect(
      Promise.race([
        adapter.resume('anything', fakeEmployeeContext(process.cwd(), process.cwd())),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 2000)),
      ]),
    ).resolves.toBe(false);
  });

  it('§7.8 test 8: clean stop leaves no orphan process (verified by live process-tree scan, not just an internal flag)', async () => {
    adapter = new GenericPtyAdapter();
    const ctx = fakeEmployeeContext(process.cwd(), process.cwd());
    await adapter.start(ctx);
    await adapter.send('hello', 'task');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await adapter.stop();
    adapter = null; // afterEach's own stop() would be a harmless no-op double-stop otherwise

    const { execFileSync } = await import('node:child_process');
    // tasklist has no command-line column even with /V (that shows window
    // title) — WMI via PowerShell is what the rest of this session's real
    // process-tree scans have used for exactly this reason.
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine"],
      { encoding: 'utf8' },
    );
    // The scripted CLI's own argv (its script path) would appear in a
    // surviving process's command line if it were still alive.
    expect(out).not.toContain('scriptedPtyCli.cjs');
  }, 10_000);

  it('lastActivityAt() reflects real silence, not the current time (M3->M4 boundary check, part 2/3, mutation b)', async () => {
    // No existing test anywhere calls a REAL adapter's lastActivityAt()
    // and checks the value — the Supervisor heartbeat tests only exercise
    // a hand-built test double. A mutation that always returns Date.now()
    // (as though every employee is always alive) passed the entire suite
    // undetected until this test existed; confirmed by temporarily
    // reintroducing that exact mutation, this is what fails. A genuinely
    // hung agent would never be caught by this bug — this test is what
    // makes that scenario provably distinguishable from "just quiet".
    adapter = new GenericPtyAdapter();
    const ctx = fakeEmployeeContext(process.cwd(), process.cwd());
    await adapter.start(ctx);
    await adapter.send('hello', 'task');
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the echo actually arrive

    const afterActivity = adapter.lastActivityAt();
    await new Promise((resolve) => setTimeout(resolve, 300)); // genuine silence — the CLI is just sitting at its prompt
    const afterSilence = adapter.lastActivityAt();

    // The real mechanism: no new bytes arrived during the silence, so the
    // timestamp must not have moved. The mutation's version would show
    // afterSilence ~300ms later than afterActivity, every time.
    expect(afterSilence).toBe(afterActivity);
  }, 10_000);
});
