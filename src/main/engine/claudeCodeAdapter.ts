import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { EngineMode } from '../../shared/models/enums';
import type { EngineAdapter } from '../../shared/engine/adapter';
import type { AgentEvent, SendKind } from '../../shared/engine/events';
import type {
  EmployeeContext,
  EngineCapabilities,
  LaunchSpec,
  PolicyVerdict,
  ProbeResult,
} from '../../shared/engine/types';
import { buildResolvedPath, resolveBinaryAbsolutePath } from './resolvedPath';
import { resolveRealExecutable } from './resolveRealExecutable';
import { buildEmployeeTempEnv, buildWindowsBaseEnv } from './windowsEnv';
import { PtySession } from './ptySession';
import { NdjsonLineBuffer } from './ndjsonLineBuffer';
import { streamJsonEventToAgentEvents, type StreamJsonState } from './claudeCodeStreamJson';
import { CLAUDE_CODE_DEFAULT_MODEL_TIERS } from './modelTiers';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;

/** Races a promise against a hard deadline — §7.1's "MUST finish < 5s" is enforced here, not hoped for. */
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
   * proving withTimeout()'s 5s deadline actually fires — without needing
   * a real OS process that hangs on exactly one fixed argv (`--version`,
   * not configurable per-call), which turned out to have no reliable,
   * portable answer on Windows.
   */
  runVersionCheck?: (binaryPath: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string>;
}

export class ClaudeCodeAdapter implements EngineAdapter {
  readonly key = 'claude-code';
  readonly supportedModes: ReadonlySet<EngineMode> = new Set(['structured', 'pty']);

  private readonly resolveBinary: () => Promise<{ resolvedPathString: string; binaryPath: string | null }>;
  private readonly runVersionCheck: (binaryPath: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string>;

  private resolvedBinaryPath: string | null = null;
  private resolvedPathString: string | null = null;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.runVersionCheck =
      options.runVersionCheck ??
      (async (binaryPath, env, timeoutMs) => {
        const { stdout } = await execFileAsync(binaryPath, ['--version'], { timeout: timeoutMs, env });
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
  }

  private mode: EngineMode | null = null;
  private ctx: EmployeeContext | null = null;
  private turnState: TurnState = 'idle';
  private pendingSends: Array<{ text: string; kind: SendKind }> = [];
  private sessionId: string | null = null;
  private stopped = false;

  // structured-mode state
  private currentChild: ChildProcess | null = null;
  // pty-mode state
  private ptySession: PtySession | null = null;

  private readonly eventQueue: AgentEvent[] = [];
  private readonly eventWaiters: Array<(value: IteratorResult<AgentEvent>) => void> = [];
  private streamEnded = false;

  async probe(): Promise<ProbeResult> {
    try {
      return await withTimeout(this.doProbe(), PROBE_TIMEOUT_MS, 'probe() exceeded 5s');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        installed: false,
        authenticated: false,
        version: null,
        binaryPath: null,
        error: message,
        metered: true, // §24.5 — cannot tell, safe direction
      };
    }
  }

  private async doProbe(): Promise<ProbeResult> {
    const { resolvedPathString, binaryPath } = await this.resolveBinary();
    if (!binaryPath) {
      return {
        installed: false,
        authenticated: false,
        version: null,
        binaryPath: null,
        error: '"claude" was not found on the resolved PATH (§15.4).',
        metered: true,
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
      if (key.startsWith('CLAUDE_CODE_') || SESSION_CONTAMINATION_VARS.includes(key)) delete probeEnv[key];
    }

    let version: string | null = null;
    try {
      version = await this.runVersionCheck(binaryPath, probeEnv, PROBE_TIMEOUT_MS - 500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { installed: true, authenticated: false, version: null, binaryPath, error: message, metered: true };
    }

    // `claude auth status` — free, local, no API spend (confirmed: exit 0 +
    // loggedIn:true when authenticated; exit 1 + loggedIn:false otherwise).
    let authenticated = false;
    let metered = true; // safe default (§24.5) unless positively known otherwise
    let authError: string | null = null;
    try {
      const { stdout } = await execFileAsync(binaryPath, ['auth', 'status'], {
        timeout: PROBE_TIMEOUT_MS - 500,
        env: probeEnv,
      });
      const status: unknown = JSON.parse(stdout);
      if (typeof status === 'object' && status !== null && 'loggedIn' in status) {
        authenticated = (status as { loggedIn: unknown }).loggedIn === true;
        // A real subscription (fixed-price) is "not metered for this
        // purpose" per §24.5; anything else (API key, unknown) stays
        // metered:true, the safe direction.
        if ('subscriptionType' in status && typeof (status as { subscriptionType: unknown }).subscriptionType === 'string') {
          metered = false;
        }
      }
    } catch (err) {
      // `claude auth status` exits non-zero when logged out — that is a
      // real, expected "not authenticated" result, not a probe failure.
      // execFile rejects on non-zero exit; its stdout is still attached to
      // the error in Node, but rather than depend on that shape, treat any
      // non-zero exit here as "not authenticated" and move on.
      authenticated = false;
      authError = err instanceof Error ? err.message : String(err);
    }

    return {
      installed: true,
      authenticated,
      version,
      binaryPath,
      error: authenticated ? null : (authError ?? 'Not logged in (`claude auth status`).'),
      metered,
    };
  }

  capabilities(_probe: ProbeResult): EngineCapabilities {
    return {
      structuredEvents: true,
      // M4: becomes true once bureau-hook exists and the real gate is
      // wired. canUseTool alone could never be this regardless (§7.6: not
      // consulted for every call), so this stays false even once the SDK
      // path exists, until the hook is what's actually answering.
      permissionCallback: false,
      // M4: becomes true once bureau-hook (the PreToolUse shim) exists.
      hookInterception: false,
      sessionResume: true,
      // Conservative default, not a limitation to route around silently
      // (§7.4, corrected M3 session 2): structured mode — the mode 'auto'
      // actually picks, since structuredEvents is true — cannot achieve a
      // real interrupt on Windows (child.kill('SIGINT') is a hard kill,
      // verified empirically). PTY mode genuinely can (\x03 into a real
      // ConPTY session delivers a catchable SIGINT, also verified) — an
      // employee explicitly configured to mode:'pty' gets a real
      // interrupt() even though this capability snapshot underclaims it.
      // Under-claiming is the safe direction; over-claiming isn't.
      interrupt: false,
      usageReporting: true,
      mcpServers: true,
      modelSelection: true,
      maxContextTokens: null, // not confirmed this session
    };
  }

  async buildLaunchSpec(ctx: EmployeeContext): Promise<LaunchSpec> {
    if (!this.resolvedBinaryPath || !this.resolvedPathString) {
      throw new Error('buildLaunchSpec() called before a successful probe()');
    }

    const stateDir = ctx.stateDir;
    const claudeConfigDir = path.join(stateDir, 'claude');
    const tempEnv = buildEmployeeTempEnv(stateDir);

    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      HOME: stateDir, // on Windows: USERPROFILE too (§7.6)
      USERPROFILE: stateDir,
      GIT_OPTIONAL_LOCKS: '0', // §10.5
      PATH: this.resolvedPathString,
      ...tempEnv,
      ...buildWindowsBaseEnv(),
      // Credentials: resolved separately by the supervisor via
      // SecretBroker.resolveForSpawn and merged in immediately before
      // spawn (session 1's design) — nothing added here. Per §7.6's M3
      // session 2 decision, the default (no broker override) means this
      // employee inherits whatever auth CLAUDE_CONFIG_DIR's own session
      // resolves to, never an injected ANTHROPIC_API_KEY.
    };

    // §7.6 MUST (M3 session 2): explicit MCP config, discovery disabled.
    // ctx.toolServer is still M4's placeholder (session 1) — nothing real
    // to pass yet, but the discovery-suppression flags apply regardless of
    // whether a real MCP server is configured, since a worktree's own
    // .mcp.json is the actual risk being closed.
    const args = ['--strict-mcp-config', '--setting-sources', ''];

    return {
      command: this.resolvedBinaryPath,
      args,
      cwd: ctx.worktreePath || ctx.stateDir, // Director: no worktree (§8.0) — falls back to stateDir
      env,
      configFiles: [],
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

  private flushOneQueued(): void {
    if (this.turnState !== 'idle' || this.pendingSends.length === 0) return;
    const next = this.pendingSends.shift();
    if (next) void this.deliver(next.text);
  }

  private async deliver(text: string): Promise<void> {
    if (!this.ctx || !this.resolvedBinaryPath) throw new Error('send() called before start()');
    this.turnState = 'generating';
    // Not yet reconciled with session 1's SecretBroker design, flagged
    // rather than silently assumed: EngineAdapter.start()/send() take only
    // EmployeeContext, not a supervisor-finalized LaunchSpec, so *some*
    // caller has to actually build the launch env each real spawn. This
    // session that's the adapter itself, via its own buildLaunchSpec() —
    // which is exactly the "MUST NOT read secrets directly" method — plus
    // a broker merge right here. With noopSecretBroker (session 1's M6
    // placeholder) that merge is a true no-op today, so this has zero
    // practical effect yet, but the *shape* of who calls buildLaunchSpec
    // and who merges the broker is a real open question the supervisor
    // (session 3) needs to settle properly, not inherit unexamined.
    const spec = await this.buildLaunchSpec(this.ctx);
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
   * Real model-tier resolution (role.model_preference -> settings.engines.
   * modelTiers -> a concrete id) is not built this session — that reads
   * settings the adapter has no access to, and deciding the right default
   * per task is arguably the supervisor's job, not the adapter's. Until
   * then, every real spawn defaults to the cheapest tier and carries a
   * small, hard --max-budget-usd ceiling as its own safety net, per this
   * session's own COST directive — regardless of what a role or task might
   * otherwise call for. `--max-turns` was considered and deliberately NOT
   * added: it does not appear in this CLI version's own --help output, and
   * inventing an unconfirmed flag is worse than relying on the flags that
   * are actually confirmed to exist.
   */
  private costSafetyArgs(): string[] {
    return ['--model', CLAUDE_CODE_DEFAULT_MODEL_TIERS.fast, '--max-budget-usd', '0.05'];
  }

  private deliverStructured(text: string, spec: LaunchSpec, env: Record<string, string>): void {
    if (!this.ctx || !this.resolvedBinaryPath) return;
    const args = [
      '-p',
      text,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      'dontAsk', // §7.3/§11.2 (M3 session 2 decision): no gate exists yet — deny everything, don't bypass
      '--allowed-tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      ...this.costSafetyArgs(),
      ...(this.sessionId ? ['--resume', this.sessionId] : []),
    ];

    const child = spawn(this.resolvedBinaryPath, args, {
      cwd: spec.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentChild = child;
    this.wireStructuredChild(child);
  }

  private wireStructuredChild(child: ChildProcess): void {
    const buffer = new NdjsonLineBuffer();
    const state: StreamJsonState = { sessionId: this.sessionId, turnIndex: 0, sawTextDeltaThisTurn: false };

    child.stdout?.on('data', (chunk: Buffer) => {
      const { parsed, malformedLines } = buffer.feed(chunk.toString('utf8'));
      for (const line of malformedLines) {
        console.error(`[claude-code adapter] malformed stream-json line: ${line}`);
      }
      for (const raw of parsed) {
        // Gated, not left in by accident: this is what surfaced the
        // "no stream_event this turn" parser gap this session — genuinely
        // useful for diagnosing a future drift the same way, kept
        // deliberately rather than stripped back out once its job was done.
        if (process.env.BUREAU_DEBUG_STREAM_JSON) console.error('[claude-code adapter debug] raw:', JSON.stringify(raw));
        for (const event of streamJsonEventToAgentEvents(raw, state)) {
          this.pushEvent(event);
        }
      }
      if (state.sessionId) this.sessionId = state.sessionId;
    });

    child.on('exit', (code) => {
      this.currentChild = null;
      this.turnState = 'idle';
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
      const args = [
        '--permission-mode',
        'dontAsk',
        '--allowed-tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        ...this.costSafetyArgs(),
        ...(this.sessionId ? ['--resume', this.sessionId] : []),
      ];
      this.ptySession = new PtySession({
        command: this.resolvedBinaryPath,
        args,
        cwd: spec.cwd,
        env,
      });
      this.ptySession.onData((chunk) => this.pushEvent({ t: 'raw', data: Buffer.from(chunk, 'utf8') }));
      this.ptySession.onExit((info) => {
        this.turnState = 'idle';
        this.pushEvent({ t: 'finished', reason: info.exitCode === 0 ? 'completed' : 'error', summary: null });
        this.flushOneQueued();
      });
    }
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
}
