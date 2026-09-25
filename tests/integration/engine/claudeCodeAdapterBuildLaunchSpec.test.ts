import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { EmployeeSchema } from '../../../src/shared/models/employee';
import { RoleSchema } from '../../../src/shared/models/role';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { buildWindowsBaseEnv } from '../../../src/main/engine/windowsEnv';
import { CLAUDE_CODE_DEFAULT_MODEL_TIERS } from '../../../src/main/engine/modelTiers';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';
import { PROBE_LIVENESS_CEILING_MS } from '../../../src/shared/engine/types';

// buildLaunchSpec's real resourceScripts.ts resolver needs a live
// Electron `app` (app.isPackaged/app.getAppPath()), which does not exist
// under plain-Node vitest — injected here the same way resolveBinary
// already is, per ClaudeCodeAdapterOptions' own doc comment.
const FAKE_HOOK_SCRIPT_PATH_RESOLVER = (): string =>
  'C:\\fake\\bureau\\resources\\bin\\bureau-hook.js';

function fakeEmployeeContext(stateDir: string, worktreePath: string): EmployeeContext {
  const now = nowIso();
  const employee = EmployeeSchema.parse({
    id: newId(),
    name: 'Quinn',
    role_key: 'engineering:developer',
    is_director: 0,
    desk_x: 0,
    desk_y: 0,
    sprite_variant: 'a',
    status: 'idle',
    status_detail: null,
    engine: 'claude-code',
    engine_mode: null,
    engine_version: null,
    model: null,
    model_tier_override: null,
    session_id: null,
    pid: null,
    process_start_time: null,
    worktree_id: null,
    current_task_id: null,
    autonomy: 'guided',
    autonomous_confirmed_at: null,
    daily_budget_usd_micros: null,
    escalate_when: '[]',
    reports: '{}',
    resume_at: null,
    heartbeat_at: null,
    consecutive_failures: 0,
    lifetime_spend_usd_micros: 0,
    hired_at: now,
    archived_at: null,
    created_at: now,
    updated_at: now,
  });
  const role = RoleSchema.parse({
    id: newId(),
    key: 'developer',
    full_key: 'engineering:developer',
    department_key: 'engineering',
    pack_id: 'engineering',
    priority: 50,
    version: '1.0.0',
    title: 'Developer',
    description: 'Writes code',
    system_prompt_path: 'prompts/developer.md',
    skills: '[]',
    deliverable_types: '[]',
    shared_prompts: '[]',
    input_types: '[]',
    engine_preference: '["claude-code"]',
    model_preference: null,
    tools_allow: '[]',
    tools_deny: '[]',
    network_allow: '[]',
    memory_scopes: '[]',
    memory_budget_tokens: 8000,
    autonomy_default: 'guided',
    max_turns: 40,
    max_attempts: 2,
    wall_clock_timeout_s: 2400,
    budget_usd_micros: null,
    escalate_when: '[]',
    reports: '{}',
    sprite_key: 'dev',
    role_options: '{}',
    engine_options: null,
    enabled: 1,
    created_at: now,
    updated_at: now,
  });
  return {
    employee,
    role,
    task: null,
    worktreePath,
    stateDir,
    baseDir: stateDir,
    toolServer: placeholderToolServer,
    controlChannel: placeholderControlChannel,
    broker: noopSecretBroker,
    modelId: null,
    turnBudgetCapUsdMicros: null,
  };
}

/**
 * §7.6/M3 step 5: "The adapter builds a valid launch spec, verified against
 * the real binary." No spawning here — buildLaunchSpec's job is composing
 * a spec, not running anything; this checks that composition is correct
 * and that the command it names genuinely exists on this machine.
 */
describe('ClaudeCodeAdapter.buildLaunchSpec (§7.6)', () => {
  /**
   * AUDIT #1. Before this, `--model` and `--max-budget-usd` were appended
   * at spawn time by a private `costSafetyArgs()` that ignored the context
   * entirely: every role of every engine got the `fast` tier's id and a
   * hardcoded $0.05 ceiling. Asserting on the spec is what makes the
   * values the process will actually run under observable without
   * spawning anything.
   */
  it('AUDIT #1: puts the Supervisor-resolved model and per-turn cap into the spec — never a hardcoded tier', async () => {
    const adapter = new ClaudeCodeAdapter({
      resolveBureauHookScriptPath: FAKE_HOOK_SCRIPT_PATH_RESOLVER,
    });
    const ctx = fakeEmployeeContext('C:\\fake\\state\\tiered', 'C:\\fake\\worktree\\tiered');

    const spec = await adapter.buildLaunchSpec({
      ...ctx,
      modelId: 'resolved-capable-model',
      turnBudgetCapUsdMicros: 3_000_000,
    });

    const modelIdx = spec.args.indexOf('--model');
    expect(modelIdx, '--model must be in the spec, not appended at spawn time').toBeGreaterThan(-1);
    expect(spec.args[modelIdx + 1]).toBe('resolved-capable-model');
    // The specific regression: the `fast` shipping id, for everyone.
    expect(spec.args).not.toContain(CLAUDE_CODE_DEFAULT_MODEL_TIERS.fast);

    const budgetIdx = spec.args.indexOf('--max-budget-usd');
    expect(budgetIdx).toBeGreaterThan(-1);
    expect(spec.args[budgetIdx + 1]).toBe('3.00');
    expect(spec.args[budgetIdx + 1], 'the old hardcoded 5¢ ceiling').not.toBe('0.05');
  });

  it('AUDIT #1: passes no --model at all when nothing resolved, rather than inventing one', async () => {
    const adapter = new ClaudeCodeAdapter({
      resolveBureauHookScriptPath: FAKE_HOOK_SCRIPT_PATH_RESOLVER,
    });
    const ctx = fakeEmployeeContext('C:\\fake\\state\\untiered', 'C:\\fake\\worktree\\untiered');

    const spec = await adapter.buildLaunchSpec({
      ...ctx,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });

    expect(spec.args).not.toContain('--model');
    expect(spec.args).not.toContain('--max-budget-usd');
  });

  it(
    'composes exactly what §7.6 lists — nothing else — and the command is a real, existing binary',
    async () => {
      const adapter = new ClaudeCodeAdapter({
        resolveBureauHookScriptPath: FAKE_HOOK_SCRIPT_PATH_RESOLVER,
      });
      // **This is the assertion that actually failed, five times (see
      // `PROJECT-CHECKLIST.md`'s Known Issues row), and it now passes for the
      // right reason rather than by getting lucky on a warm page cache.**
      //
      // `probe()` with no options takes §7.8's liveness ceiling — 30s, chosen
      // to be far above the measured cold case rather than near it. A cold
      // start (Defender scanning a 318.7 MB `claude.exe` on first touch, two
      // sequential launches) has been measured at 3875-4372ms end to end. That
      // is a slow but entirely successful probe, and a slow successful probe
      // must report `installed: true`. It used to report `installed: false`,
      // because the old 5000ms deadline sat in the gap between the warm
      // population (p99 2024ms) and the cold one, and everything past it was
      // reported as absence.
      //
      // `determination` is asserted FIRST and deliberately: if this ever fails
      // again, the failure should say "the probe did not complete" rather than
      // "the CLI is not installed", which is the sentence that cost four
      // sessions. Note also that this file is in `npm run test:security`, so
      // this assertion gates a release — a cold page cache used to fail it.
      const probeResult = await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });
      expect(probeResult.determination, probeResult.error ?? '').toBe('determined');
      expect(probeResult.installed, probeResult.error ?? '').toBe(true);

      const stateDir = 'C:\\fake\\bureau\\state\\quinn';
      const worktreePath = 'C:\\fake\\bureau\\worktrees\\quinn';
      const ctx = fakeEmployeeContext(stateDir, worktreePath);

      const spec = await adapter.buildLaunchSpec(ctx);

      // command: absolute, and a real file that actually exists.
      expect(spec.command).toBe(probeResult.binaryPath);
      expect(fs.existsSync(spec.command)).toBe(true);

      // cwd: the employee's worktree, not the state dir, not process.cwd().
      expect(spec.cwd).toBe(worktreePath);

      // env: exactly the fields §7.6 lists, nothing else.
      expect(spec.env.CLAUDE_CONFIG_DIR).toBe('C:\\fake\\bureau\\state\\quinn\\claude');
      expect(spec.env.HOME).toBe(stateDir);
      expect(spec.env.USERPROFILE).toBe(stateDir);
      expect(spec.env.GIT_OPTIONAL_LOCKS).toBe('0');
      expect(spec.env.PATH).toBeTruthy();
      expect(spec.env.TEMP).toBe('C:\\fake\\bureau\\state\\quinn\\tmp');
      expect(spec.env.TMP).toBe('C:\\fake\\bureau\\state\\quinn\\tmp');
      // Windows base allowlist keys are present (real values, machine-dependent).
      expect(spec.env.ComSpec).toBeTruthy();
      // No ANTHROPIC_API_KEY, no secrets — the broker is a separate step (session 1's design).
      expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();

      // §7.10 (M4 session 2): bureau-hook's own env, relied on via
      // inheritance through the CLI (hook configs have no env field).
      expect(spec.env.BUREAU_CONTROL_FILE).toBe('C:\\fake\\bureau\\state\\quinn\\control.json');
      expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(spec.env.BUREAU_HOOK_SELF_DEADLINE_MS).toBeTruthy();

      // MCP discovery suppression is present, plus the real explicit config.
      expect(spec.args).toContain('--strict-mcp-config');
      expect(spec.args).toContain('--setting-sources');
      expect(spec.args).toContain('--mcp-config');
      expect(spec.args).toContain('--settings');
      expect(spec.args).toContain('--allowed-tools');
      // §11.3's mcp__<server>__<tool> naming (TRAP #1) — the real allow-list
      // the model is offered, not the empty "deny everything" list M3
      // session 2 left here.
      expect(spec.args).toContain('mcp__bureau__bureau_task_done');
      expect(spec.args).toContain('Read');

      // configFiles: real now (M4 session 2) — the MCP config and hook
      // settings JSON, written before spawn (deliver()'s own job, not
      // asserted here — this only checks buildLaunchSpec's own output).
      expect(spec.configFiles).toHaveLength(2);
      const mcpConfigFile = spec.configFiles.find((f) => f.path.endsWith('mcp-config.json'));
      const settingsFile = spec.configFiles.find((f) => f.path.endsWith('claude-settings.json'));
      expect(mcpConfigFile, JSON.stringify(spec.configFiles)).toBeDefined();
      expect(settingsFile, JSON.stringify(spec.configFiles)).toBeDefined();
      const mcpConfig = JSON.parse(mcpConfigFile?.content ?? '{}') as {
        mcpServers: Record<string, unknown>;
      };
      expect(mcpConfig.mcpServers['bureau']).toBeDefined();
      const settingsConfig = JSON.parse(settingsFile?.content ?? '{}') as {
        hooks: {
          PreToolUse: Array<{ hooks: Array<{ command: string; args: string[]; timeout: number }> }>;
        };
      };
      expect(settingsConfig.hooks.PreToolUse[0]?.hooks[0]?.args).toEqual([
        'C:\\fake\\bureau\\resources\\bin\\bureau-hook.js',
      ]);
      expect(settingsConfig.hooks.PreToolUse[0]?.hooks[0]?.timeout).toBe(35 * 60); // maxHoldMinutes(30) + 5min, in seconds
      // A real `probe()` runs here, so this timeout has to clear §7.8's liveness
      // ceiling — a test timeout below the bound the code is allowed to take is
      // just the removed wall-clock assertion wearing a different hat.
    },
    PROBE_LIVENESS_CEILING_MS + 10_000,
  );

  it(
    'the Director (no worktree, §8.0) falls back to stateDir as cwd',
    async () => {
      const adapter = new ClaudeCodeAdapter({
        resolveBureauHookScriptPath: FAKE_HOOK_SCRIPT_PATH_RESOLVER,
      });
      await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });

      const stateDir = 'C:\\fake\\bureau\\state\\director';
      const ctx = fakeEmployeeContext(stateDir, ''); // '' — legitimately empty, per §8.0

      const spec = await adapter.buildLaunchSpec(ctx);
      expect(spec.cwd).toBe(stateDir);
      // A real `probe()` runs here, so this timeout has to clear §7.8's liveness
      // ceiling — a test timeout below the bound the code is allowed to take is
      // just the removed wall-clock assertion wearing a different hat.
    },
    PROBE_LIVENESS_CEILING_MS + 10_000,
  );

  it('self-resolves the binary with no prior probe() call — the real Supervisor.assign() flow (M3 session 3 fix)', async () => {
    // A real, previously-undiscovered gap: Supervisor.assign() never calls
    // probe() before start()/buildLaunchSpec() — found while building
    // GenericPtyAdapter and comparing it against this adapter's old
    // "probe() must run first" requirement. Untested until now because no
    // existing test drove a real (non-Fake) adapter through this exact
    // no-probe path. This is that test.
    const adapter = new ClaudeCodeAdapter({
      resolveBureauHookScriptPath: FAKE_HOOK_SCRIPT_PATH_RESOLVER,
    });
    const ctx = fakeEmployeeContext(
      'C:\\fake\\bureau\\state\\ravi2',
      'C:\\fake\\bureau\\worktrees\\ravi2',
    );
    const spec = await adapter.buildLaunchSpec(ctx); // no adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS }) call anywhere above
    expect(fs.existsSync(spec.command)).toBe(true);
  }, 10_000);

  it('throws a clear error when the binary genuinely cannot be resolved, self-resolution attempted or not', async () => {
    const adapter = new ClaudeCodeAdapter({
      resolveBinary: async () => ({ resolvedPathString: '', binaryPath: null }),
    });
    const ctx = fakeEmployeeContext('C:\\fake\\state', 'C:\\fake\\worktree');
    await expect(adapter.buildLaunchSpec(ctx)).rejects.toThrow(/not found on the resolved PATH/);
  });

  it('never inherits the real process environment — a canary set in process.env does not leak into the built env (M3->M4 boundary check, part 2/3, mutation a)', async () => {
    // The existing "composes exactly what §7.6 lists" test above only
    // asserts the REQUIRED keys are present with the right values — it
    // never asserted that anything else is ABSENT. A mutation that spreads
    // ...process.env before the allowlist entries (silently reinstating
    // full environment inheritance, defeating the isolation boundary M6's
    // whole threat model assumes) passed the entire suite undetected
    // until this test existed. Confirmed by temporarily reintroducing that
    // exact mutation: this specific assertion is what failed.
    const CANARY_KEY = 'BUREAU_TEST_CANARY_MUTATION_A';
    process.env[CANARY_KEY] = 'should-never-leak';
    try {
      const adapter = new ClaudeCodeAdapter({
        resolveBureauHookScriptPath: FAKE_HOOK_SCRIPT_PATH_RESOLVER,
      });
      const ctx = fakeEmployeeContext(
        'C:\\fake\\bureau\\state\\canary',
        'C:\\fake\\bureau\\worktrees\\canary',
      );
      const spec = await adapter.buildLaunchSpec(ctx);
      expect(spec.env[CANARY_KEY]).toBeUndefined();
    } finally {
      delete process.env[CANARY_KEY];
    }
  }, 10_000);

  it(
    '§11.7 S10: the built env is EXACTLY the expected closed set — no more, no less, including this dev ' +
      'sandbox\u2019s own CLAUDECODE/CLAUDE_CODE_EXECPATH-family vars (M3 root-caused those to `probe()`\u2019s and an ad-hoc ' +
      'script\u2019s own `process.env` spread — buildLaunchSpec() itself never spreads `process.env` at all, confirmed by ' +
      'reading the code before writing this assertion; PROGRESS.md\u2019s own "Correcting the record" entry). No ' +
      'tolerance list is needed as a result — a real leak here would be a real regression, not sandbox noise.',
    async () => {
      const adapter = new ClaudeCodeAdapter({
        resolveBureauHookScriptPath: FAKE_HOOK_SCRIPT_PATH_RESOLVER,
      });
      const ctx = fakeEmployeeContext(
        'C:\\fake\\bureau\\state\\s10',
        'C:\\fake\\bureau\\worktrees\\s10',
      );
      const spec = await adapter.buildLaunchSpec(ctx);

      // Derived from the real, separately-pinned buildWindowsBaseEnv()
      // (tests/unit/engine/windowsEnv.test.ts) rather than hardcoded here
      // — this machine's actual set of present base-allowlist keys is the
      // source of truth, not an assumption about which of the five exist.
      const expectedKeys = new Set([
        'CLAUDE_CONFIG_DIR',
        'HOME',
        'USERPROFILE',
        'GIT_OPTIONAL_LOCKS',
        'PATH',
        'TEMP',
        'TMP',
        'BUREAU_CONTROL_FILE',
        'ELECTRON_RUN_AS_NODE',
        'BUREAU_HOOK_SELF_DEADLINE_MS',
        ...Object.keys(buildWindowsBaseEnv()),
      ]);
      expect(new Set(Object.keys(spec.env))).toEqual(expectedKeys);

      // Named explicitly, not just implied by set-equality above — the
      // exact vars S10's own history singled out as this sandbox's known
      // contamination class.
      expect(spec.env['CLAUDECODE']).toBeUndefined();
      expect(spec.env['CLAUDE_CODE_EXECPATH']).toBeUndefined();
    },
    10_000,
  );
});
