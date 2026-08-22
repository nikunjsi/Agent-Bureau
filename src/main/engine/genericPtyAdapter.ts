import path from 'node:path';
import fs from 'node:fs';
import type { EngineMode } from '../../shared/models/enums';
import type { GenericPtyEngineOptions } from '../../shared/models/engineOptions';
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
import { PtyOutputBuffer } from './ptyOutputBuffer';

type TurnState = 'idle' | 'generating';

/**
 * §7.7 — config-driven adapter for any terminal agent, wired through the
 * exact same PTY machinery (PtySession/PtyOutputBuffer/ReadyDebouncer,
 * M3 step 3) as ClaudeCodeAdapter's own pty branch, but with real onReady
 * wiring — the one thing session 3 correction 3 decided claude-code does
 * not currently need (§7.7.1). This is now the only place PTY mode
 * actually runs.
 *
 * §7.1's `probe(): Promise<ProbeResult>` takes no arguments — a reasonable
 * assumption for an engine with one well-known binary (`claude`), but
 * generic-pty's binary is per-role config (`engine_options.command`), not
 * known until a role exists. `boundCommand` (constructor option) is the
 * seam for that mismatch: tests/contract-suite usage binds one specific
 * command upfront (so probe() has something real to answer about);
 * `start(ctx)` still re-resolves from the role's actual engine_options for
 * every real spawn, since one adapter is one running employee's session
 * (matching ClaudeCodeAdapter's own per-employee-instance model), not a
 * process-wide singleton bound to one command for its whole lifetime.
 */
export interface GenericPtyAdapterOptions {
  /** See class comment. Optional — a real per-employee instance discovers its command from ctx.role.engine_options at start(). */
  boundCommand?: string;
  resolveBinary?: (
    command: string,
  ) => Promise<{ resolvedPathString: string; binaryPath: string | null }>;
}

export class GenericPtyAdapter implements EngineAdapter {
  readonly key = 'generic-pty';
  // §7.7: config-driven wrapper around an arbitrary interactive CLI — there
  // is no structured/JSON mode to offer regardless of what's wrapped.
  readonly supportedModes: ReadonlySet<EngineMode> = new Set(['pty']);

  private readonly boundCommand: string | null;
  private readonly resolveBinary: (
    command: string,
  ) => Promise<{ resolvedPathString: string; binaryPath: string | null }>;

  private ctx: EmployeeContext | null = null;
  private options: GenericPtyEngineOptions | null = null;
  private turnState: TurnState = 'idle';
  private pendingSends: Array<{ text: string; kind: SendKind }> = [];
  private stopped = false;
  private lastActivityAtMs = Date.now();
  private ptyTurnIndex = 0;
  private ptySession: PtySession | null = null;
  private doneBuffer: PtyOutputBuffer | null = null;
  private streamEnded = false;
  private readonly eventQueue: AgentEvent[] = [];
  private readonly eventWaiters: Array<(v: IteratorResult<AgentEvent>) => void> = [];

  constructor(adapterOptions: GenericPtyAdapterOptions = {}) {
    this.boundCommand = adapterOptions.boundCommand ?? null;
    this.resolveBinary =
      adapterOptions.resolveBinary ??
      (async (command: string) => {
        const resolvedPathString = await buildResolvedPath();
        if (path.isAbsolute(command) && fs.existsSync(command)) {
          return { resolvedPathString, binaryPath: command };
        }
        const cmdOrExe = resolveBinaryAbsolutePath(command, resolvedPathString);
        // Same Windows shim-unwrapping ClaudeCodeAdapter needs (§15.4) —
        // an arbitrary npm-global-installed CLI is exactly as likely to be
        // a `.cmd` shim wrapping a real `.exe` as `claude` is.
        const binaryPath = cmdOrExe ? resolveRealExecutable(cmdOrExe) : null;
        return { resolvedPathString, binaryPath };
      });
  }

  async probe(): Promise<ProbeResult> {
    const command = this.boundCommand ?? this.options?.command ?? null;
    if (!command) {
      return {
        installed: false,
        authenticated: false,
        version: null,
        binaryPath: null,
        error: 'no command configured — generic-pty resolves its binary per-role (engine_options.command), not before a role exists',
        metered: true,
      };
    }
    try {
      const { binaryPath } = await this.resolveBinary(command);
      if (!binaryPath) {
        return {
          installed: false,
          authenticated: false,
          version: null,
          binaryPath: null,
          error: `"${command}" was not found on the resolved PATH (§15.4).`,
          metered: true,
        };
      }
      // "Authenticated" has no general meaning for an arbitrary wrapped
      // CLI — Bureau has no protocol-level way to ask one. Reports true
      // (nothing blocks a spawn attempt) rather than guessing at a
      // per-tool auth check that does not generalise.
      return { installed: true, authenticated: true, version: null, binaryPath, error: null, metered: true };
    } catch (err) {
      return {
        installed: false,
        authenticated: false,
        version: null,
        binaryPath: null,
        error: err instanceof Error ? err.message : String(err),
        metered: true,
      };
    }
  }

  /**
   * §7.7: "Capabilities are all false except what the config asserts."
   * `mode` is accepted for interface compliance (§7.1 correction 1) but
   * generic-pty has only one real mode, so it does not change the answer.
   */
  capabilities(_probe: ProbeResult, _mode?: EngineMode): EngineCapabilities {
    return {
      structuredEvents: false,
      permissionCallback: false,
      hookInterception: false,
      sessionResume: false,
      interrupt: true, // \x03 into the pty — real, same mechanism ClaudeCodeAdapter's pty branch verified
      usageReporting: false, // §7.7.1 — unmeterable, permanently
      mcpServers: false,
      modelSelection: false,
      maxContextTokens: null,
      promptCaching: false, // Bureau assembles no request payload in pty mode — see EngineCapabilities.promptCaching
    };
  }

  private engineOptionsFor(ctx: EmployeeContext): GenericPtyEngineOptions {
    const opts = ctx.role.engine_options;
    if (!opts || !('command' in opts)) {
      throw new Error(
        'GenericPtyAdapter requires role.engine_options with at least {command, ready_pattern} — this should have been rejected at role-load if missing (§7.1.1/§6.5).',
      );
    }
    return opts as GenericPtyEngineOptions;
  }

  async buildLaunchSpec(ctx: EmployeeContext): Promise<LaunchSpec> {
    const options = this.engineOptionsFor(ctx);
    const { resolvedPathString, binaryPath } = await this.resolveBinary(options.command);
    if (!binaryPath) {
      throw new Error(`"${options.command}" was not found on the resolved PATH (§15.4).`);
    }

    const stateDir = ctx.stateDir;
    const tempEnv = buildEmployeeTempEnv(stateDir);
    // Same isolation model as §7.6 — a wrapped CLI gets no more of the
    // real environment than claude-code does. No CLAUDE_CONFIG_DIR
    // equivalent here: what an arbitrary CLI needs for its own per-
    // employee state (if anything) is that CLI's own concern, not
    // something this adapter can know generically.
    const env: Record<string, string> = {
      HOME: stateDir,
      USERPROFILE: stateDir,
      GIT_OPTIONAL_LOCKS: '0',
      PATH: resolvedPathString,
      ...tempEnv,
      ...buildWindowsBaseEnv(),
    };

    return {
      command: binaryPath,
      args: options.args,
      cwd: ctx.worktreePath || ctx.stateDir,
      env,
      configFiles: [],
    };
  }

  async start(ctx: EmployeeContext): Promise<void> {
    this.ctx = ctx;
    this.options = this.engineOptionsFor(ctx);
    this.turnState = 'idle';
    this.stopped = false;
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
    // §7.8 test 3's own flow is start -> send -> events -> finished, no
    // probe() required first — buildLaunchSpec() below resolves the
    // binary itself and throws its own clear error if resolution fails,
    // on the FIRST real send (same fix applied to ClaudeCodeAdapter this
    // session — see its buildLaunchSpec() comment for the bug this closes).
    if (!this.ctx) throw new Error('send() called before start()');
    this.turnState = 'generating';
    const spec = await this.buildLaunchSpec(this.ctx);
    const secrets = await this.ctx.broker.resolveForSpawn({ employeeId: this.ctx.employee.id, engineKey: this.key });
    const env = { ...spec.env, ...secrets.env };

    if (!this.ptySession) {
      const options = this.options!;
      // Always the 'm' flag: a pattern matches one line within accumulated,
      // possibly-scrolled terminal output, never the whole buffer from its
      // start — an unanchored-to-any-line match would be nearly useless.
      // §7.7's own YAML example originally wrote this as an inline `(?m)`
      // prefix (PCRE/Python-style) — invalid JS RegExp syntax, confirmed
      // by this adapter throwing SyntaxError against its own documented
      // example the first time it was actually run (M3 session 3). Fixed
      // here and in the spec: the flag is applied automatically, never
      // written into the pattern string itself.
      let readyPattern: RegExp | undefined;
      try {
        readyPattern = new RegExp(options.ready_pattern, 'm');
      } catch (err) {
        throw new Error(`invalid ready_pattern in role.engine_options: ${err instanceof Error ? err.message : String(err)}`);
      }
      let doneRegExp: RegExp | null = null;
      if (options.done_pattern) {
        try {
          doneRegExp = new RegExp(options.done_pattern, 'm');
        } catch (err) {
          throw new Error(`invalid done_pattern in role.engine_options: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.doneBuffer = doneRegExp ? new PtyOutputBuffer({ readyPattern: doneRegExp }) : null;

      this.ptySession = new PtySession({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env,
        readyPattern,
        readyDebounceMs: options.ready_debounce_ms,
      });

      this.ptySession.onData((chunk) => {
        this.lastActivityAtMs = Date.now();
        this.doneBuffer?.feed(chunk);
        this.pushEvent({ t: 'raw', data: Buffer.from(chunk, 'utf8') });
        if (this.doneBuffer?.matchesReadyPattern()) {
          // done_pattern matched — this CLI announced it is finished, not
          // just idle between turns. §7.7's done_pattern, real signal, not
          // scraped content (§7.7.1: this is the adapter reacting to the
          // config it was given, not reading semantics out of prose).
          this.turnState = 'idle';
          this.pushEvent({ t: 'finished', reason: 'completed', summary: null });
        }
      });

      this.ptySession.onReady(() => {
        // §7.4's real turn-boundary signal for pty mode: the debounced
        // ready-pattern match. Unblocks the queue exactly here, never on
        // enqueue (§7.11 correction 2).
        this.turnState = 'idle';
        this.pushEvent({ t: 'idle' });
        this.flushOneQueued();
      });

      this.ptySession.onExit((info) => {
        this.turnState = 'idle';
        if (!this.streamEnded) {
          this.pushEvent({ t: 'finished', reason: info.exitCode === 0 ? 'completed' : 'error', summary: null });
        }
        this.flushOneQueued();
      });

      // Adapter-level bookkeeping (§7.7.1) — "I spawned a process", not
      // scraped content. sessionResume is false (capabilities()), so
      // sessionId stays null honestly.
      this.pushEvent({ t: 'session.started', sessionId: null, engineVersion: 'generic-pty', model: null });
    }

    // Bookkeeping again: "I am about to actually write this turn's text",
    // exactly at the moment the write happens (queued or immediate —
    // deliver() is only ever called at that moment, never on enqueue).
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
    // §7.7.1: no tool.requested is ever emitted for a pty-only adapter —
    // nothing calls this. Kept as a real, typed no-op so wiring code
    // written against the full EngineAdapter contract doesn't need an
    // adapter-specific branch just to skip generic-pty.
  }

  async interrupt(): Promise<void> {
    if (!this.ptySession || !this.options) return;
    this.ptySession.write(this.options.interrupt);
  }

  async stop(graceMs?: number): Promise<void> {
    this.stopped = true;
    if (this.ptySession) {
      if (graceMs) await new Promise((resolve) => setTimeout(resolve, graceMs));
      this.ptySession.kill();
      this.ptySession = null;
    }
    this.streamEnded = true;
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter({ value: undefined, done: true });
  }

  async resume(_sessionId: string, _ctx: EmployeeContext): Promise<boolean> {
    // §7.1/§7.8 test 7: "works or returns false — never hangs." Honest
    // false, not a guess: capabilities().sessionResume is false because
    // generic-pty never captures a real session id to resume in the first
    // place (no content parsing, §7.7.1) — there is nothing to resume.
    return false;
  }

  lastActivityAt(): number {
    return this.lastActivityAtMs;
  }
}
