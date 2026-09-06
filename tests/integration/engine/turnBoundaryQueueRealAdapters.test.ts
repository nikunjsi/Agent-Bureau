import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { EmployeeSchema } from '../../../src/shared/models/employee';
import { RoleSchema } from '../../../src/shared/models/role';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { GenericPtyAdapter } from '../../../src/main/engine/genericPtyAdapter';
import { noopSecretBroker, placeholderControlChannel, placeholderToolServer } from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';
import type { AgentEvent } from '../../../src/shared/engine/events';

const SCRIPTED_CLI = path.resolve('tests/helpers/scriptedPtyCli.cjs');

/**
 * §7.4 / CLAUDE.md ("do not inject a message into an agent mid-generation
 * — wait for `idle`"), AUDIT #2.
 *
 * The turn-boundary queue could be deleted from BOTH real adapters with a
 * fully green suite: the only tests covering it drove `FakeAdapter`, and
 * the one integration test whose name implied real coverage
 * (`genericPtyAdapter.test.ts`'s "the queue actually flushes mid-session")
 * waits for a real `idle` BEFORE its second `send()`, so `turnState` is
 * `'idle'` and the queue branch is never entered at all.
 *
 * Both tests here send the second message WITHOUT waiting for idle —
 * the only way to reach the branch — and assert against the real adapters.
 */
describe('§7.4 turn-boundary queue — the REAL adapters, not the test double (AUDIT #2)', () => {
  function ctxFor(engineKey: string, engineOptions: unknown): EmployeeContext {
    const now = nowIso();
    const employee = EmployeeSchema.parse({
      id: newId(), name: 'Ravi', role_key: 'engineering:developer', is_director: 0, desk_x: 0, desk_y: 0,
      sprite_variant: 'a', status: 'idle', status_detail: null, engine: engineKey, engine_mode: null,
      engine_version: null, model: null, model_tier_override: null, session_id: null, pid: null, process_start_time: null,
      worktree_id: null, current_task_id: null, autonomy: 'guided', autonomous_confirmed_at: null,
      daily_budget_usd_micros: null, escalate_when: '[]', reports: '{}', resume_at: null, heartbeat_at: null, consecutive_failures: 0,
      lifetime_spend_usd_micros: 0, hired_at: now, archived_at: null, created_at: now, updated_at: now,
    });
    const role = RoleSchema.parse({
      id: newId(), key: 'developer', full_key: 'engineering:developer', department_key: 'engineering',
      pack_id: 'engineering', priority: 50, version: '1.0.0', title: 'Developer', description: 'Writes code',
      system_prompt_path: 'prompts/developer.md', skills: '[]', deliverable_types: '[]', shared_prompts: '[]', input_types: '[]',
      engine_preference: JSON.stringify([engineKey]), model_preference: null, tools_allow: '[]', tools_deny: '[]',
      network_allow: '[]', memory_scopes: '[]', memory_budget_tokens: 8000, autonomy_default: 'guided', max_turns: 40, max_attempts: 2,
      wall_clock_timeout_s: 2400, budget_usd_micros: null, escalate_when: '[]', reports: '{}', sprite_key: 'dev', role_options: '{}',
      engine_options: engineOptions === null ? null : JSON.stringify(engineOptions),
      enabled: 1, created_at: now, updated_at: now,
    });
    return {
      employee, role, task: null, worktreePath: process.cwd(), stateDir: process.cwd(),
      memoryPack: '', decisionLog: '', toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel, broker: noopSecretBroker, effectiveAutonomy: 'ask',
      modelId: null, turnBudgetCapUsdMicros: null,
    };
  }

  let ptyAdapter: GenericPtyAdapter | null = null;
  afterEach(async () => {
    await ptyAdapter?.stop();
    ptyAdapter = null;
  });

  it('GenericPtyAdapter: a message sent mid-generation reaches the real process only AFTER the real idle', async () => {
    ptyAdapter = new GenericPtyAdapter();
    const ctx = ctxFor('generic-pty', {
      command: process.execPath,
      args: [SCRIPTED_CLI],
      ready_pattern: '(?:^|\\r|\\n)>[^\\r\\n]*$',
      done_pattern: '\\[done\\]',
      interrupt: '\x03',
      ready_debounce_ms: 100,
    });
    await ptyAdapter.start(ctx);
    const iterator = ptyAdapter.events()[Symbol.asyncIterator]();

    await ptyAdapter.send('first', 'task');
    // NO wait for idle here — this is the whole point. `turnState` is
    // 'generating', so the queue branch is the one under test.
    await ptyAdapter.send('second', 'task');

    // Record the real order of events until the second echo comes back.
    const order: string[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { value } = (await iterator.next()) as { value: AgentEvent };
      if (value.t === 'idle') order.push('idle');
      if (value.t === 'raw') {
        const text = value.data.toString('utf8');
        if (text.includes('echo: first')) order.push('echo:first');
        if (text.includes('echo: second')) order.push('echo:second');
      }
      if (order.includes('echo:second')) break;
    }

    expect(order, 'the second message never reached the real process').toContain('echo:second');
    // The discriminator. Queued: first -> idle -> second. Delivered
    // immediately (the mutation): first -> second, with NO idle between.
    //
    // Asserted as "an idle was observed, and it came first" rather than a
    // bare index comparison: `indexOf` returns -1 when idle never happened
    // at all, and -1 is trivially less than any real index, so the
    // comparison alone would pass under exactly the mutation this test
    // exists to catch.
    expect(
      order,
      `no real idle was observed before the second message was delivered; actual order was ${order.join(' -> ')}`,
    ).toContain('idle');
    expect(
      order.indexOf('idle'),
      `the second message was delivered before the turn ended; actual order was ${order.join(' -> ')}`,
    ).toBeLessThan(order.indexOf('echo:second'));
  }, 20_000);

  it('ClaudeCodeAdapter: a message sent mid-generation is NOT delivered — no second turn is launched', async () => {
    // `deliver()` is the only caller of `buildLaunchSpec()`, which is the
    // only caller of this injected resolver — so counting it counts real
    // delivery attempts, using a seam the adapter already exposes. Nothing
    // about the queue itself is stubbed.
    let launchSpecBuilds = 0;
    const adapter = new ClaudeCodeAdapter({
      resolveBureauHookScriptPath: () => {
        launchSpecBuilds += 1;
        return path.resolve('dist/resources/bin/bureau-hook.js');
      },
      // A real, harmless binary: it is spawned for real, rejects claude's
      // argv, and exits. That is enough — the turn legitimately becomes
      // 'generating' and never returns to idle (no stream-json ever
      // arrives), which is exactly the state the queue exists for.
      resolveBinary: async () => ({ resolvedPathString: '', binaryPath: process.execPath }),
    });
    const ctx = ctxFor('claude-code', { mode: 'structured' });
    // The real Supervisor.assign() order: start(), then buildLaunchSpec()
    // (which is what self-resolves the binary), then send().
    await adapter.start(ctx);
    await adapter.buildLaunchSpec(ctx);
    const afterAssign = launchSpecBuilds;

    await adapter.send('first', 'task');
    expect(
      launchSpecBuilds - afterAssign,
      'the first send should deliver immediately — the adapter was idle',
    ).toBe(1);

    await adapter.send('second', 'task');
    await adapter.send('third', 'task');

    // Queued: still 1. Delivered mid-generation (the mutation): 2 or 3,
    // i.e. a second `claude -p` process launched into a live turn.
    expect(
      launchSpecBuilds - afterAssign,
      'a send() during an active turn launched another turn instead of queueing (§7.4)',
    ).toBe(1);

    await adapter.stop();
  }, 20_000);
});
