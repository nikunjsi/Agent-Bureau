import { spawn, execFile, type ChildProcess } from 'node:child_process';
import type Database from 'better-sqlite3';
import {
  DEFAULT_HOOK_TIMING,
  resolveHookTiming,
  validateHookTiming,
  type HookTiming,
} from '../controlChannel/hookTiming';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import type { EngineMode } from '../../shared/models/enums';
import type { EngineAdapter } from '../../shared/engine/adapter';
import type { AgentEvent, SendKind } from '../../shared/engine/events';
import type {
  EmployeeContext,
  EngineCapabilities,
  LaunchSpec,
  PolicyVerdict,
  ProbeOptions,
  ProbeResult,
} from '../../shared/engine/types';
import { PROBE_LIVENESS_CEILING_MS } from '../../shared/engine/types';
import { buildResolvedPath, resolveBinaryAbsolutePath } from './resolvedPath';
import { containEngineChild, type ContainProcess } from './containEngineChild';
import { resolveRealExecutable } from './resolveRealExecutable';
import { buildEmployeeTempEnv, buildWindowsBaseEnv } from './windowsEnv';
import { PtySession } from './ptySession';
import { NdjsonLineBuffer } from './ndjsonLineBuffer';
import { streamJsonEventToAgentEvents, type StreamJsonState } from './claudeCodeStreamJson';
import { microsToUsd } from '../../shared/models/money';
import { resolveBureauHookScriptPath as realResolveBureauHookScriptPath } from './resourceScripts';
import { EMPLOYEE_TOOL_HANDLERS } from '../controlChannel/toolHandlers';
import { BUREAU_MCP_SERVER_NAME } from '../../shared/policy/evaluator';
import type { ToolClass } from '../../shared/policy/types';

const execFileAsync = promisify(execFile);

/**
 * Thrown inside `doProbe` the moment the caller's budget is gone, and
 * caught by `probe()` — which is the only place that turns it into the
 * fail-closed `indeterminate` result. Deliberately not exported: nothing
 * outside this file should be branching on it, because the whole point of
 * `ProbeDetermination` is that the answer travels in the result, not in a
 * thrown type only one caller could catch.
 */
class ProbeBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeBudgetExhaustedError';
  }
}

/**
 * Invariant #12: money is integer micro-dollars everywhere inside Bureau.
 * The CLI's `--max-budget-usd` flag is the one boundary where it has to
 * become a decimal string, so the conversion happens here, once, at the
 * edge — never by carrying a float around internally.
 */
function usdMicrosToCliAmount(micros: number): string {
  return microsToUsd(micros).toFixed(2);
}

/** §23.2's tool-class table, for the real Claude Code tool names this
 * adapter's own PreToolUse hook actually sees. `bureau` is deliberately
 * absent — checked centrally, cross-engine, by isBureauTool() (§7.9: every
 * engine reaches the same MCP tool server). A name not in this map (e.g.
 * `Task`/`Agent`, or an unrecognised future tool) classifies as `other`,
 * which denies by default (§11.3) — correct independently of
 * `deny.subagent_spawn` also catching those two by name. */
const CLAUDE_CODE_TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  LS: 'read',
  // P-9 (pre-M11): Claude Code defers MCP tool schemas behind this meta-tool,
  // so an agent must call it before any `bureau_*` tool. It reads schemas of
  // tools the session already has, reaches nothing else, and every tool it
  // surfaces is still gated when called. Classified `other`, it was denied,
  // and no agent could report a task done (the real M4 gate caught this).
  ToolSearch: 'read',
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  Bash: 'command',
  WebFetch: 'network',
  WebSearch: 'network',
};

/** §11.2: "declared per adapter in `capabilities.networkTools`." */
const CLAUDE_CODE_NETWORK_TOOLS: readonly string[] = ['WebFetch', 'WebSearch'];

/** Races a promise against a hard deadline — §7.8's liveness ceiling is enforced here, not hoped for. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

type TurnState = 'idle' | 'generating' | 'toolRunning' | 'awaitingApproval';

/**
 * §7.6: the reference adapter. Structured mode (`-p --output-format
 * stream-json --include-partial-messages`) is the default; PTY mode is the
 * explicit fallback. Both are built for real this session; the SDK's
 * in-process `canUseTool` path is NOT — see capabilities() below for
 * exactly what that means for gating this session, and §7.6 for the full
 * reasoning.
 *
 * §7.4/turn model: each `send()` in structured mode is a fresh, short-lived
 * `claude -p` process, chained to the same logical session via `--resume`
 * once a `session.started` event has captured a real session id — not one
 * long-lived process fed incrementally over stdin. This is a deliberate
 * scope decision, not an oversight: `--input-format stream-json`'s exact
 * stdin message shape was not confirmed against the current docs this
 * session (research effort went into the better-confirmed output shapes
 * and the fail-closed hook correction instead), and "one process per turn,
 * chained by --resume" is fully specified by confirmed, tested CLI
 * behaviour. PTY mode is genuinely one persistent process, fed via the
 * pty's own input channel, matching §7.4 literally.
 */
export interface ClaudeCodeAdapterOptions {
  /**
   * Injectable resolver — real §15.4 resolution by default. Overridable so
   * probe()'s "binary absent" and "binary present but hanging" failure
   * cases (§7.8 test 1) are unit-testable without touching real system
   * PATH or needing a real hung process; matches the project's established
   * pattern for pulling a hard-to-trigger real dependency out for direct
   * testability (M2's dispatchIpcCall).
   */
  resolveBinary?: () => Promise<{ resolvedPathString: string; binaryPath: string | null }>;
  /**
   * Injectable "run `--version`" step — real `execFile` by default.
   * Overridable so the "binary present but hanging" failure case (§7.8
   * test 1) is testable by simulating a promise that never resolves,
   * proving withTimeout()'s deadline actually fires (§7.8's liveness
   * ceiling, since this session split the old single 5s bound in two) —
   * without needing
   * a real OS process that hangs on exactly one fixed argv (`--version`,
   * not configurable per-call), which turned out to have no reliable,
   * portable answer on Windows.
   */
  runVersionCheck?: (
    binaryPath: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ) => Promise<string>;
  /**
   * Injectable — real resourceScripts.ts (dev-vs-packaged, TRAP #3) by
   * default. Overridable because the real function needs a live Electron
   * `app` (app.isPackaged/app.getAppPath()), which does not exist under
   * plain-Node tests (vitest never runs inside Electron) — the same
   * "pull the hard-to-trigger real dependency out for direct testability"
   * pattern as resolveBinary/runVersionCheck above, first needed here
   * because buildLaunchSpec is the first thing in this file to touch
   * Electron at all. (bureau-tools' own script path is NOT resolved
   * here — it comes from ctx.toolServer.command, already built by
   * spawnSupervisedEmployee.ts before EmployeeContext ever reaches this
   * adapter; only the hook's path is this adapter's own concern.)
   */
  resolveBureauHookScriptPath?: () => string;
  /**
   * S-1 (§7.10 items 1-3): the hook timing from real settings. Production
   * builds adapters through `createClaudeCodeAdapterFromSettings`, which
   * resolves and validates it. Defaults to the registered defaults for a
   * caller with no settings database (a probe, a test).
   */
  hookTiming?: HookTiming;
  /**
   * M11 row S1-9: puts each spawned engine process into Bureau's Job
   * Object. Production passes the real `containProcess`; omitted, nothing
   * is contained (see containEngineChild.ts for why it is injected).
   */
  containProcess?: ContainProcess;
}

export class ClaudeCodeAdapter implements EngineAdapter {
  readonly key = 'claude-code';
  /**
   * §7.7.1/M3 session 3 correction 3's decision: claude-code is
   * structured-only. Structured mode already works (§7.3 prefers it);
   * generic-pty exists for CLIs without structured output; the only real
   * use for claude-code-in-a-pty is "take control" (§14.5), a later
   * permission, not this session. Until then PTY-for-claude-code buys
   * nothing and costs a fragile ready-pattern, a per-directory trust gate
   * (§7.6), and no session resume. `deliverPty`/`PtySession` machinery
   * below is kept, not deleted — "take control" will likely need it — but
   * it is structurally unreachable via normal flows: resolveMode() below
   * defends against an explicit 'pty' request even reaching it, and
   * `insertRole` rejects `mode: 'pty'` for this engine before a role
   * exists to spawn one (src/shared/models/engineOptions.ts). §7.12 names
   * "take control" shipping as the trigger to revisit this.
   */
  readonly supportedModes: ReadonlySet<EngineMode> = new Set(['structured']);

  private readonly resolveBinary: () => Promise<{
    resolvedPathString: string;
    binaryPath: string | null;
  }>;
  private readonly runVersionCheck: (
    binaryPath: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ) => Promise<string>;
  private readonly resolveBureauHookScriptPath: () => string;
  private readonly hookTiming: HookTiming;

  private resolvedBinaryPath: string | null = null;
  private resolvedPathString: string | null = null;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    // Validated here as well as at startup: an adapter built with a timing
    // that lets the engine's fail-open timeout win must not exist at all.
    this.hookTiming = validateHookTiming(options.hookTiming ?? DEFAULT_HOOK_TIMING);
    this.containProcess = options.containProcess;
    this.runVersionCheck =
      options.runVersionCheck ??
      (async (binaryPath, env, timeoutMs) => {
        const { stdout } = await execFileAsync(binaryPath, ['--version'], {
          timeout: timeoutMs,
          env,
        });
        return stdout.trim();
      });
    this.resolveBinary =
      options.resolveBinary ??
      (async () => {
        const resolvedPathString = await buildResolvedPath();
        const cmdOrExe = resolveBinaryAbsolutePath('claude', resolvedPathString);
        // §15.4 finds `claude.cmd` (it's what's actually on PATH); Node
        // cannot spawn that directly on Windows (spawn EINVAL, confirmed
        // empirically) — prefer the real .exe the shim wraps, when it can
        // be found. See resolveRealExecutable.ts for the full story.
        const binaryPath = cmdOrExe ? resolveRealExecutable(cmdOrExe) : null;
        return { resolvedPathString, binaryPath };
      });
    this.resolveBureauHookScriptPath =
      options.resolveBureauHookScriptPath ?? realResolveBureauHookScriptPath;
  }

  private mode: EngineMode | null = null;
  private ctx: EmployeeContext | null = null;
  private turnState: TurnState = 'idle';
  private pendingSends: Array<{ text: string; kind: SendKind }> = [];
  private deliveryGate: (() => boolean) | null = null;
  private sessionId: string | null = null;
  private stopped = false;
  private lastActivityAtMs = Date.now();
  /** Set whenever probe() succeeds — PTY mode's own synthesized `session.started` (below) has no other honest source for this field, which §7.2 requires non-null. */
  private cachedEngineVersion: string | null = null;
  /** PTY mode's own turn counter, for the `turnIndex` it reports on each synthesized `turn.started` — mirrors structured mode's stream-json convention (0-based, incremented after use), not read by the supervisor's counting (§7.11 correction 2 counts occurrences, not values) but kept honest for anything else that reads the event. */
  private ptyTurnIndex = 0;

  // structured-mode state
  private currentChild: ChildProcess | null = null;
  private readonly containProcess: ContainProcess | undefined;
  // pty-mode state
  private ptySession: PtySession | null = null;

  private readonly eventQueue: AgentEvent[] = [];
  private readonly eventWaiters: Array<(value: IteratorResult<AgentEvent>) => void> = [];
  private streamEnded = false;

  /**
   * §7.8's two bounds, applied. See `ProbeOptions.budgetMs` for why the
   * budget comes from the caller and why the ceiling caps it.
   *
   * **Every exit from the `catch` is `indeterminate`, and that is the fix.**
   * Running out of budget, and any unexpected throw from the steps below,
   * both mean the same thing: this probe did not find out. It used to report
   * that as `installed: false`, which is a claim about the user's machine
   * that nothing here observed — on a cold start (Defender scanning a 318.7
   * MB `claude.exe` on first touch, 97% of the elapsed time being the CLI's
   * own startup) it was reliably false. The pessimistic field values stay
   * exactly as they were, because invariant #6 has not changed; what changed
   * is that the result now says it is guessing.
   */
  async probe(options: ProbeOptions): Promise<ProbeResult> {
    const budgetMs = Math.max(0, Math.min(options.budgetMs, PROBE_LIVENESS_CEILING_MS));
    const deadlineAtMs = Date.now() + budgetMs;
    try {
      return await withTimeout(
        this.doProbe(deadlineAtMs),
        budgetMs,
        `probe() did not finish within its ${budgetMs}ms budget (§7.8)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        installed: false,
        authenticated: false,
        version: null,
        binaryPath: null,
        error: `Could not determine whether claude-code is installed: ${message}`,
        metered: true, // §24.5 — cannot tell, safe direction
        determination: 'indeterminate',
      };
    }
  }

  /**
   * The per-launch budget, derived from the outer deadline rather than
   * guessed at.
   *
   * **This replaced `PROBE_TIMEOUT_MS - 500`, which was not a reserve.** That
   * expression was passed to *each* of two sequential launches, so two
   * launches could legally consume 9000ms inside a 5000ms budget — the inner
   * timeouts could not enforce the outer one, and only `withTimeout` was
   * actually holding the bound. Whatever is left of the caller's budget is
   * the only number that cannot be exceeded by construction, however many
   * launches this method grows.
   */
  private remainingBudgetMs(deadlineAtMs: number, step: string): number {
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) {
      throw new ProbeBudgetExhaustedError(`no budget left before ${step} (§7.8)`);
    }
    return remaining;
  }

  private async doProbe(deadlineAtMs: number): Promise<ProbeResult> {
    const { resolvedPathString, binaryPath } = await this.resolveBinary();
    if (!binaryPath) {
      return {
        installed: false,
        authenticated: false,
        version: null,
        binaryPath: null,
        error: '"claude" was not found on the resolved PATH (§15.4).',
        metered: true,
        // A real, observed answer: the resolver looked and it is not there.
        // This is exactly the case the `indeterminate` state exists to stop
        // being confused with, so it must keep saying `determined`.
        determination: 'determined',
      };
    }
    this.resolvedBinaryPath = binaryPath;
    this.resolvedPathString = resolvedPathString;

    // Strips the *specific* CLAUDE_CODE_* session vars this very process
    // runs with, keeps everything else — found the hard way, M3 session 2:
    // building Bureau *inside* Claude Code means this process's own env
    // already carries CLAUDECODE=1, CLAUDE_CODE_EXECPATH (pointing at a
    // *different* claude.exe — the IDE extension's bundled binary),
    // CLAUDE_CODE_MESSAGING_SOCKET, and more — the same class of self-
    // inflicted contamination as M2's ELECTRON_RUN_AS_NODE leak, first
    // caught here when a real-auth probe came back authenticated:false on
    // a machine that is genuinely logged in. A blanket "strip anything
    // starting with CLAUDE" would also strip CLAUDE_CONFIG_DIR — a
    // legitimate, intentional override (this is exactly how the
    // "unauthenticated" test below points probe() at a fresh identity) —
    // so this denies the specific confirmed contaminants by name instead
    // of a prefix. Unlike buildLaunchSpec's deliberate per-employee
    // isolation (a synthetic HOME/USERPROFILE), probe() is a system-level
    // check — it needs the real home directory to find the real system
    // config, so this can't be the minimal Windows allowlist either; only
    // the specific contamination goes, not the whole environment.
    const SESSION_CONTAMINATION_VARS = [
      'CLAUDECODE',
      'CLAUDE_PID',
      'CLAUDE_EFFORT',
      'AI_AGENT',
      'CLAUDE_AGENT_SDK_VERSION',
    ];
    const probeEnv: NodeJS.ProcessEnv = { ...process.env, PATH: resolvedPathString };
    for (const key of Object.keys(probeEnv)) {
      if (key.startsWith('CLAUDE_CODE_') || SESSION_CONTAMINATION_VARS.includes(key))
        delete probeEnv[key];
    }

    let version: string | null = null;
    try {
      version = await this.runVersionCheck(
        binaryPath,
        probeEnv,
        this.remainingBudgetMs(deadlineAtMs, '`claude --version`'),
      );
    } catch (err) {
      // Two very different failures arrive here as the same rejection, and
      // telling them apart is the point of this session. `--version` exiting
      // non-zero is an observation: the binary is on disk and does not run.
      // `--version` being killed because its budget ran out is not an
      // observation about anything — and it is the common case cold, where
      // this single launch alone has been measured at 9846ms. The clock, not
      // the error's shape, decides: `runVersionCheck` is injectable and its
      // rejection shape is not part of the contract, whereas the deadline is
      // the same fact for every implementation of it.
      if (Date.now() >= deadlineAtMs) {
        throw new ProbeBudgetExhaustedError('`claude --version` ran out of budget (§7.8)');
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        installed: true,
        authenticated: false,
        version: null,
        binaryPath,
        error: message,
        metered: true,
        determination: 'determined',
      };
    }

    // `claude auth status` — free, local, no API spend (confirmed: exit 0 +
    // loggedIn:true when authenticated; exit 1 + loggedIn:false otherwise).
    let authenticated = false;
    let metered = true; // safe default (§24.5) unless positively known otherwise
    let authError: string | null = null;
    try {
      const { stdout } = await execFileAsync(binaryPath, ['auth', 'status'], {
        timeout: this.remainingBudgetMs(deadlineAtMs, '`claude auth status`'),
        env: probeEnv,
      });
      const status: unknown = JSON.parse(stdout);
      if (typeof status === 'object' && status !== null && 'loggedIn' in status) {
        authenticated = (status as { loggedIn: unknown }).loggedIn === true;
        // A real subscription (fixed-price) is "not metered for this
        // purpose" per §24.5; anything else (API key, unknown) stays
        // metered:true, the safe direction.
        if (
          'subscriptionType' in status &&
          typeof (status as { subscriptionType: unknown }).subscriptionType === 'string'
        ) {
          metered = false;
        }
      }
    } catch (err) {
      // `claude auth status` exits non-zero when logged out — that is a
      // real, expected "not authenticated" result, not a probe failure.
      // execFile rejects on non-zero exit; its stdout is still attached to
      // the error in Node, but rather than depend on that shape, treat any
      // non-zero exit here as "not authenticated" and move on.
      //
      // Except when the budget is gone — same reasoning as the `--version`
      // step above, and it matters more here: this is the launch measured at
      // 1279ms against `--version`'s 512ms, so it is the one more likely to
      // be the step that runs out. "Logged out" and "I never got to ask" are
      // not the same answer to give a user.
      if (Date.now() >= deadlineAtMs) {
        throw new ProbeBudgetExhaustedError('`claude auth status` ran out of budget (§7.8)');
      }
      authenticated = false;
      authError = err instanceof Error ? err.message : String(err);
    }

    if (version) this.cachedEngineVersion = version;

    return {
      installed: true,
      authenticated,
      version,
      binaryPath,
      error: authenticated ? null : (authError ?? 'Not logged in (`claude auth status`).'),
      metered,
      determination: 'determined',
    };
  }

  /**
   * M3 session 3 correction 1: takes `mode` as an explicit parameter rather
   * than reading `this.mode`, so the answer never silently goes stale
   * relative to when a caller happens to ask. `mode` unset (or
   * `'structured'`) is the engine-level/optimistic answer §7.3's
   * auto-selection needs — resolveMode() below calls it exactly that way,
   * before any mode exists to be honest about. A resolved `'pty'` returns
   * the honest, reduced set: no usage reporting (nothing to scrape it
   * from, §7.7.1 — REJECTED, not deferred), no session resume (the session
   * id is only ever captured by parsing structured output, never PTY's),
   * no prompt-caching credit (Bureau assembles no request payload of its
   * own in PTY mode — see EngineCapabilities.promptCaching's own comment),
   * and — unlike the old single-snapshot version, which deliberately
   * under-claimed `interrupt: false` everywhere to stay safe — a real
   * `interrupt: true`, since PTY's \x03-into-ConPTY interrupt is genuinely
   * verified and now has an honest place to say so instead of hiding it.
   */
  capabilities(_probe: ProbeResult, mode?: EngineMode): EngineCapabilities {
    if (mode === 'pty') {
      return {
        structuredEvents: false,
        permissionCallback: false, // canUseTool needs the SDK path, not built this session (§7.6) — stays false regardless of mode
        // M4 session 2: bureau-hook is real and wired via spec.args
        // (buildLaunchSpec) for either mode — the hook config is not
        // mode-specific. This branch is unreachable in production
        // (§7.7.1: mode:'pty' is rejected at role-load for claude-code)
        // but kept honest rather than left stale.
        hookInterception: true,
        sessionResume: false,
        interrupt: true,
        usageReporting: false,
        mcpServers: true,
        modelSelection: true,
        maxContextTokens: null,
        promptCaching: false,
        // A tool name means the same thing regardless of transport — only
        // structuredEvents differs — so this branch declares the same
        // table as the structured one below, not an empty one.
        networkTools: CLAUDE_CODE_NETWORK_TOOLS,
        toolClasses: CLAUDE_CODE_TOOL_CLASSES,
      };
    }
    return {
      structuredEvents: true,
      // canUseTool alone could never be this regardless (§7.6: not
      // consulted for every call), so this stays false even once the SDK
      // path exists, until the hook is what's actually answering.
      permissionCallback: false,
      // M4 session 2: real — bureau-hook is wired via buildLaunchSpec's
      // own spec.args (the MCP config + hook registration written to
      // disk, --mcp-config/--settings/--allowed-tools passed to the real
      // spawn), proven by the real-agent gate test, not just declared.
      hookInterception: true,
      sessionResume: true,
      // Structured mode cannot achieve a real interrupt on Windows
      // (child.kill('SIGINT') is a hard kill, verified empirically) — the
      // mode-aware branch above is where the real PTY answer lives now.
      interrupt: false,
      usageReporting: true,
      mcpServers: true,
      modelSelection: true,
      maxContextTokens: null, // not confirmed this session
      promptCaching: true,
      networkTools: CLAUDE_CODE_NETWORK_TOOLS,
      toolClasses: CLAUDE_CODE_TOOL_CLASSES,
    };
  }

  async buildLaunchSpec(ctx: EmployeeContext): Promise<LaunchSpec> {
    // M3 session 3: previously required a prior probe() call to have
    // already populated these — a real, previously-undiscovered gap,
    // found while building GenericPtyAdapter's equivalent: Supervisor.
    // assign() never calls probe() before start()/buildLaunchSpec(), so a
    // real ClaudeCodeAdapter spawn through the Supervisor would have
    // thrown immediately in production, untested because no existing test
    // drives Supervisor against a real (non-Fake) adapter end to end.
    // Self-resolving here (matching GenericPtyAdapter's own design) means
    // probe() stays a genuinely optional diagnostic — Settings/wizard use
    // it for "is this installed/authenticated", but spawning no longer
    // depends on it having run first.
    if (!this.resolvedBinaryPath || !this.resolvedPathString) {
      const { resolvedPathString, binaryPath } = await this.resolveBinary();
      if (!binaryPath) {
        throw new Error('"claude" was not found on the resolved PATH (§15.4).');
      }
      this.resolvedBinaryPath = binaryPath;
      this.resolvedPathString = resolvedPathString;
    }

    const stateDir = ctx.stateDir;
    const claudeConfigDir = path.join(stateDir, 'claude');
    const tempEnv = buildEmployeeTempEnv(stateDir);

    // §7.10 items 2-3 (S-1): the timing is real settings now, resolved and
    // validated once when the adapter was built (`validateHookTiming`:
    // the self-deadline strictly below the registered hook timeout, so
    // bureau-hook's deny always answers before the engine's fail-open
    // timeout could).
    const { registeredHookTimeoutSeconds, hookSelfDeadlineMs } = this.hookTiming;

    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      HOME: stateDir, // on Windows: USERPROFILE too (§7.6)
      USERPROFILE: stateDir,
      GIT_OPTIONAL_LOCKS: '0', // §10.5
      PATH: this.resolvedPathString,
      ...tempEnv,
      ...buildWindowsBaseEnv(),
      // bureau-hook's own copy of these — hook configs have no `env`
      // field of their own (confirmed against the current docs), so this
      // is genuinely relied on via inheritance through the CLI's own
      // spawn env, unlike the MCP server's env block below (TRAP #2:
      // that one is explicit on purpose, this one has no alternative).
      // Harmless for the CLI binary itself — it isn't Electron, so
      // ELECTRON_RUN_AS_NODE is simply an env var it never reads.
      BUREAU_CONTROL_FILE: path.join(stateDir, 'control.json'),
      ELECTRON_RUN_AS_NODE: '1',
      BUREAU_HOOK_SELF_DEADLINE_MS: String(hookSelfDeadlineMs),
      // Credentials: resolved separately by the supervisor via
      // SecretBroker.resolveForSpawn and merged in immediately before
      // spawn (session 1's design) — nothing added here. Per §7.6's M3
      // session 2 decision, the default (no broker override) means this
      // employee inherits whatever auth CLAUDE_CONFIG_DIR's own session
      // resolves to, never an injected ANTHROPIC_API_KEY.
    };

    // §7.6 MUST: explicit MCP config AND explicit hook registration,
    // discovery disabled for both — ctx.toolServer is real now (M4
    // session 2, built by spawnSupervisedEmployee.ts), not a placeholder.
    const mcpConfigPath = path.join(stateDir, 'mcp-config.json');
    const settingsPath = path.join(stateDir, 'claude-settings.json');
    const mcpConfig = {
      mcpServers: {
        [BUREAU_MCP_SERVER_NAME]: {
          command: ctx.toolServer.command,
          args: ctx.toolServer.args,
          env: ctx.toolServer.env,
        },
      },
    };
    const settingsConfig = {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: process.execPath,
                args: [this.resolveBureauHookScriptPath()],
                timeout: registeredHookTimeoutSeconds,
              },
            ],
          },
        ],
      },
    };

    // §11.3's mcp__<server>__<tool> naming (confirmed against the current
    // hooks docs — TRAP #1) — exactly the set the interim policy
    // evaluator (policyEvaluator.ts) allows, so the model can actually
    // see and attempt them. The hook is still the real, dynamic gate for
    // every one of these; this list only controls what the model is
    // *offered*, the same defense-in-depth layering §10.3.1 uses
    // elsewhere in this project.
    const allowedTools = [
      'Read',
      'Grep',
      'Glob',
      ...Object.keys(EMPLOYEE_TOOL_HANDLERS).map(
        (name) => `mcp__${BUREAU_MCP_SERVER_NAME}__${name}`,
      ),
    ];

    const args = [
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--mcp-config',
      mcpConfigPath,
      '--settings',
      settingsPath,
      '--permission-mode',
      'dontAsk', // still headless — -p can never answer an interactive prompt regardless of what the hook decides
      '--allowed-tools',
      ...allowedTools,
      // §7.5 (AUDIT #1): the model this role's declared tier resolved to,
      // decided by the Supervisor against the real settings map. Built
      // into the spec — not appended at spawn time — so what this
      // employee will actually run under is visible in one returned
      // object, and testable without spawning anything.
      ...(ctx.modelId ? ['--model', ctx.modelId] : []),
      // §11.5.1: the per-turn backstop. Both flags verified present in
      // this CLI version's own `--help` output (AUDIT, 2026-09-05).
      ...(ctx.turnBudgetCapUsdMicros !== null
        ? ['--max-budget-usd', usdMicrosToCliAmount(ctx.turnBudgetCapUsdMicros)]
        : []),
    ];

    return {
      command: this.resolvedBinaryPath,
      args,
      cwd: ctx.worktreePath || ctx.stateDir, // Director: no worktree (§8.0) — falls back to stateDir
      env,
      configFiles: [
        { path: mcpConfigPath, content: JSON.stringify(mcpConfig) },
        { path: settingsPath, content: JSON.stringify(settingsConfig) },
      ],
    };
  }

  async start(ctx: EmployeeContext): Promise<void> {
    this.ctx = ctx;
    this.mode = this.resolveMode(ctx);
    this.turnState = 'idle';
    this.stopped = false;
  }

  private resolveMode(ctx: EmployeeContext): EngineMode {
    const requested = ctx.role.engine_options?.mode ?? 'auto'; // §7.3, corrected M3 session 2
    if (requested === 'auto') {
      const caps = this.capabilities({} as ProbeResult);
      return caps.structuredEvents && this.supportedModes.has('structured') ? 'structured' : 'pty';
    }
    // Fail closed (CLAUDE.md §21) rather than trust an explicit request
    // blindly: role-load validation (engineOptions.ts) is supposed to be
    // the only place `mode: 'pty'` gets rejected for this engine, but a
    // single enforcement point for a "should never happen" state is
    // exactly the kind of single point of failure this project's own
    // multi-layer enforcement philosophy (§10.3.1) argues against. If
    // something upstream ever lets an unsupported mode through anyway,
    // this throws clearly instead of silently spawning it.
    if (!this.supportedModes.has(requested)) {
      throw new Error(
        `claude-code does not support mode:'${requested}' (supportedModes: ${[...this.supportedModes].join(', ')}) — this should have been rejected at role-load (§7.7.1).`,
      );
    }
    return requested;
  }

  async send(text: string, kind: SendKind): Promise<void> {
    if (this.stopped) {
      throw new Error('send() called after stop() — this adapter instance is no longer usable');
    }
    if (this.turnState !== 'idle') {
      this.pendingSends.push({ text, kind });
      return;
    }
    await this.deliver(text);
  }

  /**
   * M11 row S1-10: the Supervisor's answer to "may a queued send go out
   * now?", consulted before any flush. A park or a pause closes it, so the
   * child's own `exit` cannot launch a fresh, billed turn the Supervisor
   * has already decided not to run (pre-M11 §F, from N-1).
   */
  setDeliveryGate(gate: (() => boolean) | null): void {
    this.deliveryGate = gate;
  }

  /** Discards whatever is queued and returns how many were dropped. */
  dropQueuedSends(): number {
    const dropped = this.pendingSends.length;
    this.pendingSends = [];
    return dropped;
  }

  private flushOneQueued(): void {
    if (this.turnState !== 'idle' || this.pendingSends.length === 0) return;
    // Ask the Supervisor before spending: a closed gate means parked or
    // stopping, and the send stays queued rather than starting a turn.
    if (this.deliveryGate !== null && !this.deliveryGate()) return;
    const next = this.pendingSends.shift();
    if (next) void this.deliver(next.text);
  }

  private async deliver(text: string): Promise<void> {
    if (!this.ctx || !this.resolvedBinaryPath) throw new Error('send() called before start()');
    this.turnState = 'generating';
    // §11.4/seams.ts (settled M6 session 3): this adapter is the sole
    // caller of both buildLaunchSpec() (the "MUST NOT read secrets
    // directly" method) and the broker's own resolveForSpawn() — see
    // seams.ts's SecretBroker doc comment for the full reasoning. claude-
    // code is structured-only (§7.7.1), so this deliver() call genuinely
    // spawns a fresh child every time (deliverStructured, below) —
    // re-resolving the broker on every call is correct here, not
    // wasteful, unlike GenericPtyAdapter's own PTY-mode delivery, which
    // only truly spawns once (see its own re-spawn guard).
    const spec = await this.buildLaunchSpec(this.ctx);
    // §7.1.1: LaunchSpec.configFiles is "written before spawn" — this is
    // that write. Nothing consumed it before M4 session 2 (buildLaunchSpec
    // always returned an empty array); now it carries the real MCP config
    // and hook settings JSON files the CLI args below point at.
    for (const file of spec.configFiles) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content, 'utf8');
    }
    const secrets = await this.ctx.broker.resolveForSpawn({
      employeeId: this.ctx.employee.id,
      engineKey: this.key,
    });
    const env = { ...spec.env, ...secrets.env };
    if (this.mode === 'pty') {
      this.deliverPty(text, spec, env);
    } else {
      this.deliverStructured(text, spec, env);
    }
  }

  // ---- structured mode ----

  /**
   * The argv for one structured turn. Extracted so `--resume` can be
   * asserted without spawning anything (M11 row S1-11): resuming is what
   * makes the Director's conversation survive a restart, and it is one
   * flag deep inside a spawn otherwise.
   */
  buildTurnArgs(text: string, spec: LaunchSpec): string[] {
    return [
      '-p',
      text,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      // §7.6/§11.3 (M4 session 2): the MCP config, the hook registration,
      // --permission-mode, and --allowed-tools all come from
      // buildLaunchSpec's own spec.args now — one real gate (the hook),
      // not the "deny everything, no gate exists yet" shape M3 session 2
      // left here. Read from spec, not rebuilt, so this can never drift
      // from what buildLaunchSpec actually computed and wrote to disk.
      ...spec.args,
      ...(this.sessionId ? ['--resume', this.sessionId] : []),
    ];
  }

  private deliverStructured(text: string, spec: LaunchSpec, env: Record<string, string>): void {
    if (!this.ctx || !this.resolvedBinaryPath) return;
    const args = this.buildTurnArgs(text, spec);

    const child = spawn(this.resolvedBinaryPath, args, {
      cwd: spec.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentChild = child;
    // M11 row S1-9: contained the moment it exists. On failure the process
    // is killed at once, and the turn ends with that reason (invariant #6).
    const notContained = containEngineChild(child.pid, this.containProcess);
    this.wireStructuredChild(child, notContained);
    if (notContained !== null) child.kill();
  }

  private wireStructuredChild(child: ChildProcess, notContained: string | null = null): void {
    const buffer = new NdjsonLineBuffer();
    const state: StreamJsonState = {
      sessionId: this.sessionId,
      turnIndex: 0,
      sawTextDeltaThisTurn: false,
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      this.lastActivityAtMs = Date.now();
      const { parsed, malformedLines } = buffer.feed(chunk.toString('utf8'));
      for (const line of malformedLines) {
        console.error(`[claude-code adapter] malformed stream-json line: ${line}`);
      }
      for (const raw of parsed) {
        // Gated, not left in by accident: this is what surfaced the
        // "no stream_event this turn" parser gap this session — genuinely
        // useful for diagnosing a future drift the same way, kept
        // deliberately rather than stripped back out once its job was done.
        if (process.env.BUREAU_DEBUG_STREAM_JSON)
          console.error('[claude-code adapter debug] raw:', JSON.stringify(raw));
        for (const event of streamJsonEventToAgentEvents(raw, state)) {
          this.pushEvent(event);
        }
      }
      if (state.sessionId) this.sessionId = state.sessionId;
    });

    child.on('exit', (code) => {
      this.currentChild = null;
      this.turnState = 'idle';
      if (notContained !== null) {
        // Killed for being uncontained: this turn failed for that reason,
        // and nothing queued behind it is launched by it.
        this.pushEvent({ t: 'finished', reason: 'error', summary: notContained });
        return;
      }
      this.pushEvent({
        t: 'finished',
        reason: code === 0 ? 'completed' : 'error',
        summary: null,
      });
      this.flushOneQueued();
    });

    child.on('error', (err) => {
      this.currentChild = null;
      this.turnState = 'idle';
      this.pushEvent({ t: 'finished', reason: 'error', summary: err.message });
    });
  }

  // ---- pty mode ----

  private deliverPty(text: string, spec: LaunchSpec, env: Record<string, string>): void {
    if (!this.ctx || !this.resolvedBinaryPath) return;
    if (!this.ptySession) {
      // §7.7.1: claude-code is structured-only — mode:'pty' is rejected at
      // role-load, so this branch is unreachable through the normal path.
      // Kept consistent with deliverStructured's own spec.args reuse
      // anyway, defensively, per the same §10.3.1 reasoning resolveMode's
      // own comment already gives for not trusting a single enforcement
      // point.
      const args = [...spec.args, ...(this.sessionId ? ['--resume', this.sessionId] : [])];
      this.ptySession = new PtySession({
        command: this.resolvedBinaryPath,
        args,
        cwd: spec.cwd,
        env,
      });
      // M11 row S1-9, as for structured mode above.
      const notContained = containEngineChild(this.ptySession.pid, this.containProcess);
      if (notContained !== null) {
        this.ptySession.kill();
        this.ptySession = null;
        this.turnState = 'idle';
        this.pushEvent({ t: 'finished', reason: 'error', summary: notContained });
        return;
      }
      this.ptySession.onData((chunk) => {
        this.lastActivityAtMs = Date.now();
        this.pushEvent({ t: 'raw', data: Buffer.from(chunk, 'utf8') });
      });
      this.ptySession.onExit((info) => {
        this.turnState = 'idle';
        this.pushEvent({
          t: 'finished',
          reason: info.exitCode === 0 ? 'completed' : 'error',
          summary: null,
        });
        this.flushOneQueued();
      });
      // §7.7.1/§7.2 (M3 session 3): the adapter's own bookkeeping of its
      // own action — "I just spawned a pty process" — not scraped content,
      // so this doesn't reopen the rejected-parser decision. Fires exactly
      // once per adapter instance, right here where `this.ptySession` is
      // first constructed. sessionId stays null (honest — PTY mode never
      // discovers a real session id without content parsing, matching
      // capabilities(..., 'pty').sessionResume === false).
      this.pushEvent({
        t: 'session.started',
        sessionId: null,
        engineVersion: this.cachedEngineVersion ?? 'unknown (pty mode, not probed this run)',
        model: null,
      });
    }
    // Same bookkeeping principle: "I am about to actually write this turn's
    // text to the pty" is a fact Bureau itself knows, unconditionally, at
    // the exact moment deliverPty() runs — which (§7.4) is only ever the
    // moment a send() is either delivered immediately or a queued one is
    // flushed on idle, never on enqueue. This is the ONE place a PTY turn
    // is counted (§7.11 correction 2 — supervisor.recordTurnStarted()).
    this.pushEvent({ t: 'turn.started', turnIndex: this.ptyTurnIndex });
    this.ptyTurnIndex += 1;
    this.ptySession.write(`${text}\r`);
  }

  async *events(): AsyncIterable<AgentEvent> {
    while (!this.streamEnded) {
      const next = this.eventQueue.shift();
      if (next) {
        yield next;
        continue;
      }
      const event = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        this.eventWaiters.push(resolve);
      });
      if (event.done) return;
      yield event.value;
    }
  }

  private pushEvent(event: AgentEvent): void {
    const waiter = this.eventWaiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.eventQueue.push(event);
    }
  }

  async applyVerdict(_callId: string, _verdict: PolicyVerdict): Promise<void> {
    // M4: no real gate exists yet (capabilities().hookInterception/
    // permissionCallback are both false this session) — nothing calls
    // this against a real pending tool call today. Kept as a real,
    // typed no-op rather than throwing, so wiring code written against
    // the full EngineAdapter contract doesn't need an adapter-specific
    // branch just to skip claude-code.
  }

  async interrupt(): Promise<void> {
    // §7.4 (corrected M3 session 2): real only in PTY mode.
    if (this.mode === 'pty' && this.ptySession) {
      this.ptySession.write('\x03');
      return;
    }
    // Structured mode: no real graceful interrupt achievable on Windows
    // (child.kill('SIGINT') is a hard kill, verified empirically) —
    // capabilities().interrupt is false for exactly this reason, so a
    // caller checking capabilities first should never reach here for a
    // structured-mode employee. If it's called anyway, do nothing rather
    // than silently hard-killing the session under the name "interrupt".
  }

  async stop(graceMs?: number): Promise<void> {
    this.stopped = true;
    if (this.currentChild) {
      this.currentChild.kill();
      this.currentChild = null;
    }
    if (this.ptySession) {
      this.ptySession.kill();
      this.ptySession = null;
    }
    void graceMs; // no graceful-shutdown protocol to negotiate with the CLI itself; both paths above are already immediate
    this.streamEnded = true;
    for (const waiter of this.eventWaiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async resume(sessionId: string, ctx: EmployeeContext): Promise<boolean> {
    // §7.1: "false if unsupported or gone. MUST NOT hang." A real check
    // needs a real spawn (--resume fails at spawn time for a gone
    // session) — done by the caller's next send(), not eagerly here,
    // to avoid spawning a process just to answer this question. Reports
    // true (supported in principle) without verifying the specific
    // session still exists; a genuinely gone session surfaces as a
    // 'finished'/'error' event on the first real send() instead.
    this.sessionId = sessionId;
    this.ctx = ctx;
    this.mode = this.resolveMode(ctx);
    return true;
  }

  lastActivityAt(): number {
    return this.lastActivityAtMs;
  }
}

/**
 * S-1: the one way production builds a claude-code adapter, so the hook
 * timing is always the user's settings, resolved and validated. Throws
 * `HookTimingInvalidError` (a readable UserFacingError) for a combination
 * that would let the engine's fail-open hook timeout decide.
 */
export function createClaudeCodeAdapterFromSettings(
  db: Database.Database,
  options: Omit<ClaudeCodeAdapterOptions, 'hookTiming'> = {},
): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({ ...options, hookTiming: resolveHookTiming(db) });
}
