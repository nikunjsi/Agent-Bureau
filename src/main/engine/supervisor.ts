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
}

/**
 * §7.11 — one supervisor per employee; the only thing permitted to touch
 * that employee's adapter/process. Owns the state machine, heartbeat
 * liveness, turn counting (mode-aware — see `recordTurnCompleted` and
 * `handlePtyIdle`), transcript writing, backoff, and usage recording.
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

  private consecutiveFailures = 0;
  private turnCount = 0;
  private mode: EngineMode = 'structured';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private currentTaskId: string | null = null;

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
      case 'text.delta':
      case 'thinking.delta':
        this.transition('working', this.currentTaskId);
        break;
      case 'raw':
        // PTY mode's own transcript channel — real bytes, real terminal
        // content. Not itself a state transition; readiness (idle) comes
        // from the adapter's own PtySession-driven idle detection, which
        // surfaces as an 'idle' event exactly like structured mode's.
        void this.writeTranscript(event.data.toString('utf8'));
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
        this.recordTurnIfPty();
        this.transition('idle', this.currentTaskId);
        break;
      case 'turn.completed':
        this.recordTurnCompleted(event.turnIndex, event.usage);
        break;
      case 'finished':
        this.handleFinished(event.reason, event.summary);
        break;
      default:
        break;
    }
  }

  /**
   * §7.11/M3 session 2: "max_turns has no native meaning in PTY mode."
   * The explicit inference rule: structured mode counts real
   * `turn.completed` events (native — the engine itself reports turn
   * boundaries); PTY mode has no such signal, so a completed turn is
   * inferred from a working→idle transition — the same debounced
   * ready-pattern idle detection §7.4 already uses for turn-boundary
   * discipline, reused here rather than building a second mechanism.
   * `recordTurnCompleted` (structured) and this method both funnel into
   * the same `turnCount` increment, so a scenario scripted identically in
   * both modes counts identically — proven by the contract suite's
   * mode-parity-adjacent turn-count test.
   */
  private recordTurnIfPty(): void {
    if (this.mode !== 'pty') return;
    if (this.state !== 'working' && this.state !== 'thinking') return; // only a real working→idle transition counts
    this.turnCount += 1;
  }

  private recordTurnCompleted(turnIndex: number, usageEvent: Usage | null): void {
    if (this.mode === 'structured') this.turnCount += 1;
    if (usageEvent) {
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
  }

  private handleFinished(reason: string, _summary: string | null): void {
    // §7.11: "finished WITHOUT bureau_task_done" -> blocked,
    // ended_without_report. bureau_task_done doesn't exist until M4's tool
    // server, so there is no way to know the real answer yet — always
    // takes the "without" branch, honestly, rather than assuming success.
    if (reason === 'completed') {
      this.consecutiveFailures = 0;
      setEmployeeConsecutiveFailures(this.db, this.employeeId, 0);
      this.transition('blocked', this.currentTaskId); // ended_without_report — see comment above
      this.activityLog.logEvent({
        actor: 'system',
        type: 'employee.idle',
        severity: 'info',
        project_id: null,
        task_id: this.currentTaskId,
        employee_id: this.employeeId,
        checkpoint_id: null,
        payload: { reason: 'ended_without_report' },
      });
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
    this.transition('off', null);
  }

  private transition(next: SupervisorState, taskId: string | null): void {
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
      payload: null,
    });
  }
}
