import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { EngineAdapter } from '../../shared/engine/adapter';
import type { AgentEvent } from '../../shared/engine/events';
import type { EmployeeContext, Usage } from '../../shared/engine/types';
import type { EngineMode } from '../../shared/models/enums';
import {
  getEmployeeById,
  setEmployeeStatus,
  setEmployeeHeartbeat,
  setEmployeeConsecutiveFailures,
} from '../db/repositories/employees';
import { insertUsage } from '../db/repositories/usage';
import { nowIso } from '../../shared/models/ids';
import { TerminalBroadcaster, type TerminalBroadcasterOptions } from './terminalBroadcaster';
import type { TokenRegistry } from '../controlChannel/tokens';
import type { SupervisorRegistry } from './supervisorRegistry';

/**
 * §7.11 states — the exact set M1's `EmployeeStatusSchema` already used
 * (confirmed to match, session 1 finding), so the supervisor's own state
 * type is that schema's inferred type, not a second, parallel enum.
 */
export type SupervisorState =
  | 'off'
  | 'starting'
  | 'idle'
  | 'working'
  | 'thinking'
  | 'blocked'
  | 'waiting'
  | 'parked'
  | 'failed'
  | 'stopping';

/**
 * §11.4/M6: the real redactor's single choke point does not exist yet —
 * this is the same "route through the interface the real thing will
 * implement" pattern session 1 used for contract test 9's canary check.
 * Writes plaintext today only because the broker is still a no-op
 * (session 1) so nothing sensitive actually flows through it yet; flagged
 * explicitly in PROGRESS.md, not hidden behind a passing test.
 */
export interface TranscriptWriter {
  write(employeeId: string, chunk: string): Promise<void>;
}

export function createFileTranscriptWriter(baseDir: string): TranscriptWriter {
  return {
    async write(employeeId: string, chunk: string): Promise<void> {
      await fs.promises.mkdir(baseDir, { recursive: true });
      await fs.promises.appendFile(path.join(baseDir, `${employeeId}.transcript.log`), chunk);
    },
  };
}

export interface HeartbeatConfig {
  /** §7.11 (M3 session 2): liveness for structured mode = any SDK message. Legitimate reasoning (or a slow tool call) can run several minutes with no new message — this must be generous, not tight. */
  structuredTimeoutMs: number;
  /** Liveness for PTY mode = any byte on the stream (even a spinner redraw). No "the model is thinking" signal exists to wait out, so a real hang can be caught sooner. */
  ptyTimeoutMs: number;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  structuredTimeoutMs: 10 * 60_000,
  ptyTimeoutMs: 5 * 60_000,
};

export interface SupervisorOptions {
  db: Database.Database;
  activityLog: ActivityLog;
  adapter: EngineAdapter;
  transcriptWriter?: TranscriptWriter;
  heartbeat?: Partial<HeartbeatConfig>;
  /** How often the liveness timer checks — real default 15s; tests inject something far shorter. */
  heartbeatCheckIntervalMs?: number;
  maxAttempts?: number;
  /** Passed straight to the owned TerminalBroadcaster — tests use this to inject fake-timer-friendly coalescing/small ring-buffer caps. */
  terminalBroadcaster?: TerminalBroadcasterOptions;
  /**
   * M4 session 2 — §7.10: a token "is revoked when the process exits."
   * Optional so every existing test that doesn't care about the control
   * channel keeps constructing a Supervisor without them; when both are
   * given, stop() revokes this employee's token and removes it from the
   * registry as part of the same stop sequence that already tears down
   * the adapter and the terminal broadcaster — the process really is
   * gone by that point, so the token being usable a moment longer would
   * be exactly the "survives the process that minted it" gap M4 session
   * 1 built the whole stale-control.json sweep to catch on restart; doing
   * it here means a clean stop never needs that sweep to catch it at all.
   */
  tokenRegistry?: TokenRegistry;
  supervisorRegistry?: SupervisorRegistry;
}

/**
 * §7.11 — one supervisor per employee; the only thing permitted to touch
 * that employee's adapter/process. Owns the state machine, heartbeat
 * liveness, turn counting (one mode-symmetric mechanism — see
 * `recordTurnStarted`), transcript writing, backoff, and usage recording
 * (`recordUsage`).
 *
 * Explicitly NOT this class's job (M6): budget enforcement, the circuit
 * breaker, spend thresholds. It writes real `usage` rows (§22.4,
 * `source: 'turn'`) so spend is visible; it does not act on them.
 */
export class Supervisor {
  private state: SupervisorState = 'off';
  private readonly db: Database.Database;
  private readonly activityLog: ActivityLog;
  private readonly adapter: EngineAdapter;
  private readonly transcriptWriter: TranscriptWriter | null;
  private readonly heartbeatConfig: HeartbeatConfig;
  private readonly heartbeatCheckIntervalMs: number;
  private readonly maxAttempts: number;
  /**
   * §17.1/§17.2 M3 step 8 — public (not private) because this is exactly
   * what employees.sendInput/resizePty/takeControl/releaseControl and the
   * terminalChunk push need to reach, once a live per-employee registry
   * exists to route IPC calls to the right Supervisor instance (that
   * registry is IPC-layer plumbing, not this class's job — see
   * src/main/ipc/handlers/employees.ts). Fed from `raw` AgentEvents
   * alongside the transcript writer (below), not a separate stream.
   */
  readonly terminal: TerminalBroadcaster;

  private consecutiveFailures = 0;
  private turnCount = 0;
  private mode: EngineMode = 'structured';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private currentTaskId: string | null = null;
  private readonly tokenRegistry: TokenRegistry | null;
  private readonly supervisorRegistry: SupervisorRegistry | null;
  /**
   * M4 session 2 — set by noteTaskDone(), the control channel's own direct
   * call (via SupervisorRegistry) telling this supervisor that
   * bureau_task_done landed for a specific task, made synchronously inside
   * that same tool-call handler, after the task's own DB row is already
   * 'review'. handleFinished() reads this once, on the next 'finished'
   * event, to pick the §7.11 branch — see its own comment for the race
   * this resolves and how.
   */
  private taskDoneReportedForTaskId: string | null = null;

  constructor(
    readonly employeeId: string,
    options: SupervisorOptions,
  ) {
    this.db = options.db;
    this.activityLog = options.activityLog;
    this.adapter = options.adapter;
    this.transcriptWriter = options.transcriptWriter ?? null;
    this.heartbeatConfig = { ...DEFAULT_HEARTBEAT_CONFIG, ...options.heartbeat };
    this.heartbeatCheckIntervalMs = options.heartbeatCheckIntervalMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.terminal = new TerminalBroadcaster(employeeId, options.terminalBroadcaster);
    this.tokenRegistry = options.tokenRegistry ?? null;
    this.supervisorRegistry = options.supervisorRegistry ?? null;
  }

  /**
   * M4 session 2 — the mechanism the M3->M4 boundary report flagged as
   * missing: "the control channel must inform the supervisor when
   * task_done lands, or the gate cannot pass." Called by the control
   * channel's bureau_task_done tool handler, looked up through
   * SupervisorRegistry by employeeId (the token's own identity, never
   * agent-suppliable) — see supervisorRegistry.ts for why a direct call,
   * not an event bus or DB polling. Idempotent in effect: recording the
   * same taskId twice (a duplicate call the DB-level check already
   * rejected before this is ever reached) just overwrites the same value.
   */
  noteTaskDone(taskId: string): void {
    this.taskDoneReportedForTaskId = taskId;
  }

  get currentState(): SupervisorState {
    return this.state;
  }

  get turnsCompleted(): number {
    return this.turnCount;
  }

  /**
   * §7.11: `off --assign--> starting --ready--> idle`. Reads
   * `consecutive_failures` from the *current* row rather than starting at
   * 0 — otherwise backoff resets on every relaunch and a permanently
   * broken employee retries forever, exactly the bug this session was
   * asked to close.
   */
  async assign(ctx: EmployeeContext): Promise<void> {
    const employeeRow = getEmployeeById(this.db, this.employeeId);
    this.consecutiveFailures = employeeRow?.consecutive_failures ?? 0;
    this.currentTaskId = ctx.task?.id ?? null;
    this.mode = (ctx.role.engine_options?.mode ?? 'auto') === 'pty' ? 'pty' : 'structured';

    this.transition('starting', ctx.task?.id ?? null);
    await this.adapter.start(ctx);

    // §7.6 (M3 session 1, "finally has somewhere to attach", M3 session 2
    // prompt): keys only, never values — the launch event records what
    // shape of environment this employee actually got, without ever
    // logging a credential.
    const spec = await this.adapter.buildLaunchSpec(ctx);
    this.activityLog.logEvent({
      actor: 'system',
      type: 'employee.started',
      severity: 'info',
      project_id: null,
      task_id: this.currentTaskId,
      employee_id: this.employeeId,
      checkpoint_id: null,
      payload: { envKeys: Object.keys(spec.env) },
    });

    this.startHeartbeatMonitor();
    void this.consumeEvents();

    // §7.11: the supervisor is the only thing permitted to touch this
    // employee's adapter, so it is the one place the task's content
    // actually gets delivered — found missing at the M3->M4 boundary
    // check (nothing anywhere called send() with the task; every existing
    // test passed regardless, because FakeAdapter's scripted events
    // replay whether or not send() was ever called). Routed through the
    // adapter's own send() — the normal §7.4 turn-boundary queue, not a
    // spawn-time special case: if the adapter isn't idle yet, this queues
    // and flushes on the first real idle event exactly like any other
    // send(), using the mechanism that already exists and is tested,
    // rather than a second one built just for this.
    //
    // Scope discipline: the task BODY only. EmployeeContext also carries
    // memoryPack/decisionLog — composing those into a full context pack
    // is M10/M11's job (memory retrieval, Director context assembly);
    // sending a half-built version of that now would be worse than the
    // seam this leaves marked.
    if (ctx.task) {
      await this.adapter.send(ctx.task.body, 'task');
    }
  }

  private async consumeEvents(): Promise<void> {
    try {
      for await (const event of this.adapter.events()) {
        this.noteActivity();
        this.handleEvent(event);
        if (this.stopping) break;
      }
    } catch (err) {
      this.handleFailure(err instanceof Error ? err.message : String(err));
    } finally {
      // Once the event stream ends — for any reason, `finished`, a crash,
      // or the adapter's generator simply returning — nothing will ever
      // call noteActivity() again. Leaving the heartbeat monitor running
      // against a now-permanently-frozen lastActivityAt() would eventually
      // fire a spurious "hung" alert for a session that is not hung, it is
      // just over. Unconditional, not folded into handleFinished/
      // handleFailure specifically, so it also covers a script or a real
      // adapter ending its stream without an explicit `finished` event.
      this.stopHeartbeatMonitor();
    }
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.t) {
      case 'session.started':
        this.transition('idle', this.currentTaskId);
        break;
      case 'turn.started':
        // §7.11/M3 session 3 correction 2: the ONE place turnCount
        // increments — see recordTurnStarted's own comment for why this
        // replaced two separate, disagreeing mechanisms.
        this.recordTurnStarted();
        this.transition('working', this.currentTaskId);
        break;
      case 'text.delta':
      case 'thinking.delta':
        this.transition('working', this.currentTaskId);
        break;
      case 'raw':
        // PTY mode's own transcript channel — real bytes, real terminal
        // content. Not itself a state transition; readiness (idle) comes
        // from the adapter's own PtySession-driven idle detection, which
        // surfaces as an 'idle' event exactly like structured mode's. Fed
        // to BOTH sinks — the M6 redaction seam (persisted) and the live
        // xterm.js broadcaster (§17.1 M3 step 8) — same bytes, two
        // independent purposes, neither aware of the other.
        void this.writeTranscript(event.data.toString('utf8'));
        this.terminal.feed(event.data);
        break;
      case 'tool.requested':
        // No real gate exists yet (M4/M6) — capabilities().hookInterception
        // and permissionCallback are both false (session 2 part 1), so
        // nothing actually resolves this to allow/deny today. Reflects the
        // *shape* of §7.11's transition without pretending gating happens.
        this.transition('thinking', this.currentTaskId);
        break;
      case 'tool.completed':
        this.transition('working', this.currentTaskId);
        break;
      case 'idle':
        this.transition('idle', this.currentTaskId);
        break;
      case 'turn.completed':
        this.recordUsage(event.turnIndex, event.usage);
        break;
      case 'finished':
        this.handleFinished(event.reason, event.summary);
        break;
      default:
        break;
    }
  }

  /**
   * §7.11/M3 session 3 correction 2: ONE turn counter, not two. Session 2
   * built a PTY-only inference (a working→idle ready-pattern transition)
   * living alongside structured mode's own `turn.completed`-driven count —
   * two mechanisms counting the same thing, free to disagree, which
   * matters because `max_turns` feeds M6's enforcement. Replaced with a
   * single, mode-symmetric rule: count on `turn.started`, always, in both
   * modes — structured mode's is a real event parsed from the SDK stream;
   * PTY mode's is the adapter's own honest bookkeeping of its own action
   * (§7.7.1 — not scraped content, just "I just wrote to the pty"),
   * emitted only when a queued send() actually goes out (§7.4), never on
   * enqueue — a queued message counting early would inflate the total
   * while the agent is still mid-turn on the previous one. A scenario
   * scripted identically in both modes now counts identically by
   * construction, not by two branches happening to agree — proven by the
   * contract suite's mode-parity test.
   */
  private recordTurnStarted(): void {
    this.turnCount += 1;
  }

  /**
   * Usage recording only — no longer a counting site. PTY mode never emits
   * `turn.completed` at all (§7.7.1: there is no usage signal to attach to
   * one), so this only ever fires for structured mode's real, engine-
   * reported usage.
   */
  private recordUsage(turnIndex: number, usageEvent: Usage | null): void {
    if (!usageEvent) return;
    // §22.4: source='turn', the three token/cost columns real, turn_index
    // recorded. Visibility only — no threshold, no enforcement (M6).
    insertUsage(this.db, {
      employee_id: this.employeeId,
      task_id: this.currentTaskId,
      engine: this.adapter.key,
      model: usageEvent.model,
      tokens_in: usageEvent.tokensIn,
      tokens_out: usageEvent.tokensOut,
      tokens_cache_read: usageEvent.tokensCacheRead,
      tokens_cache_write: usageEvent.tokensCacheWrite,
      cost_usd_micros: usageEvent.costUsdMicros,
      turn_index: turnIndex,
      source: 'turn',
    });
  }

  /**
   * §7.11's two `finished` rows, now both real:
   * "finished WITH a prior bureau_task_done" -> task already 'review'
   * (the tool handler's own DB write, M4 session 2), employee -> idle.
   * "finished WITHOUT it" -> task -> blocked, reason ended_without_report.
   *
   * The race the M4 session 2 prompt asked to be decided: bureau_task_done
   * arrives over HTTP (a separate code path from this adapter-event
   * stream) and *may* still be in flight when 'finished' fires here. This
   * reads `taskDoneReportedForTaskId` once, synchronously — if the report
   * hasn't landed yet, this takes the pessimistic ended_without_report
   * branch, exactly as before. But that is not the end of the story: the
   * report, whenever it does land, is allowed to still correct a task
   * sitting in blocked/ended_without_report back to review (see server.ts's
   * task-status validation) — "bureau_task_done is the only way a task
   * completes" (§7.9) applies regardless of which side of this race it
   * lands on, not only when it wins. This method never blocks waiting for
   * it; the correction, if any, happens on the other code path.
   */
  private handleFinished(reason: string, _summary: string | null): void {
    if (reason === 'completed') {
      this.consecutiveFailures = 0;
      setEmployeeConsecutiveFailures(this.db, this.employeeId, 0);

      const gotReport = this.taskDoneReportedForTaskId !== null && this.taskDoneReportedForTaskId === this.currentTaskId;
      this.taskDoneReportedForTaskId = null;

      if (gotReport) {
        this.transition('idle', this.currentTaskId, { reason: 'task_reported' });
      } else {
        this.transition('blocked', this.currentTaskId, { reason: 'ended_without_report' });
      }
    } else {
      this.handleFailure(`adapter finished with reason=${reason}`);
    }
  }

  /** §7.11: exit≠0 or heartbeat timeout -> failed, backoff, retry to max_attempts. */
  private handleFailure(message: string): void {
    this.consecutiveFailures += 1;
    setEmployeeConsecutiveFailures(this.db, this.employeeId, this.consecutiveFailures);
    this.transition('failed', this.currentTaskId);
    this.activityLog.logEvent({
      actor: 'system',
      type: 'employee.crashed',
      severity: 'error',
      project_id: null,
      task_id: this.currentTaskId,
      employee_id: this.employeeId,
      checkpoint_id: null,
      payload: { message, consecutiveFailures: this.consecutiveFailures, maxAttempts: this.maxAttempts },
    });
    this.stopHeartbeatMonitor();
  }

  // ---- heartbeat ----

  private startHeartbeatMonitor(): void {
    this.stopHeartbeatMonitor();
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), this.heartbeatCheckIntervalMs);
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private checkHeartbeat(): void {
    if (this.state === 'off' || this.state === 'failed' || this.state === 'stopping') return;
    const timeoutMs = this.mode === 'pty' ? this.heartbeatConfig.ptyTimeoutMs : this.heartbeatConfig.structuredTimeoutMs;
    const silentForMs = Date.now() - this.adapter.lastActivityAt();
    if (silentForMs <= timeoutMs) return;
    this.activityLog.logEvent({
      actor: 'system',
      type: 'employee.heartbeat_missed',
      severity: 'warn',
      project_id: null,
      task_id: this.currentTaskId,
      employee_id: this.employeeId,
      checkpoint_id: null,
      payload: { silentForMs, timeoutMs, mode: this.mode },
    });
    this.handleFailure(`heartbeat timeout: silent for ${silentForMs}ms (limit ${timeoutMs}ms)`);
  }

  private noteActivity(): void {
    setEmployeeHeartbeat(this.db, this.employeeId, nowIso());
  }

  // ---- transcript ----

  private async writeTranscript(chunk: string): Promise<void> {
    if (!this.transcriptWriter) return;
    try {
      await this.transcriptWriter.write(this.employeeId, chunk);
    } catch (err) {
      console.error(`[supervisor] transcript write failed for ${this.employeeId}:`, err);
    }
  }

  // ---- lifecycle ----

  async stop(graceMs?: number): Promise<void> {
    this.stopping = true;
    this.stopHeartbeatMonitor();
    this.transition('stopping', this.currentTaskId);
    await this.adapter.stop(graceMs);
    this.terminal.dispose();
    // §7.10: a token "is revoked when the process exits" — the adapter's
    // process is what just stopped, above, so this is that exact moment.
    // Optional deps (see SupervisorOptions' own comment): every test that
    // predates the control channel keeps working unchanged.
    this.tokenRegistry?.revoke(this.employeeId);
    this.supervisorRegistry?.unregister(this.employeeId);
    this.transition('off', null);
  }

  // ---- "take control" (§14.5) ----

  /**
   * Grants write access through the read-only-by-default gate
   * (TerminalBroadcaster.takeControl) and, per §14.5's ordering,
   * interrupt()s the current generation first so a mid-turn take-over
   * can't interleave with output already in flight.
   *
   * Honest limitation, flagged rather than silently half-built: §14.5
   * also says taking control "blocks Bureau's own send() until control is
   * released" — enforcing THAT half needs a hook into whatever routes
   * Bureau's own automated messages (the Director, checkpoints, steering),
   * which does not exist until a real caller does (M9/M11). Not solved
   * here. What IS real: the read-only gate itself, and interrupt-on-take.
   * The input sink also routes through the adapter's normal, turn-boundary
   * -queued send(data, 'user') — §7.1's contract has no separate raw/
   * immediate write path, so keystroke-by-keystroke low-latency typing
   * isn't achieved by this alone either; it's queued like any other send.
   */
  async takeControl(controllerId: string): Promise<boolean> {
    const granted = this.terminal.takeControl(controllerId, (data) => {
      void this.adapter.send(data, 'user');
    });
    if (granted) await this.adapter.interrupt();
    return granted;
  }

  releaseControl(controllerId: string): void {
    this.terminal.releaseControl(controllerId);
  }

  sendControlInput(controllerId: string, data: string): boolean {
    return this.terminal.sendInput(controllerId, data);
  }

  /**
   * `payload` (M4 session 2 addition): callers that need to attach context
   * to the transition's own event (e.g. handleFinished's task_reported /
   * ended_without_report) pass it here instead of emitting a second,
   * separate event for the same state change — CLAUDE.md invariant #3
   * ("every state change... emits exactly one activity event") applies to
   * this method's callers as much as anywhere else; a prior version of
   * handleFinished emitted a second, differently-typed event alongside
   * this one for the same transition, which both violated that and used
   * the wrong type name (`employee.idle` for a transition *into*
   * `blocked`) — fixed as part of this same change, not filed separately.
   */
  private transition(next: SupervisorState, taskId: string | null, payload: Record<string, unknown> | null = null): void {
    if (this.state === next) return;
    this.state = next;
    setEmployeeStatus(this.db, this.employeeId, next);
    this.activityLog.logEvent({
      actor: 'system',
      type: `employee.${next}`,
      severity: 'info',
      project_id: null,
      task_id: taskId,
      employee_id: this.employeeId,
      checkpoint_id: null,
      payload,
    });
  }
}
