import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { EngineAdapter } from '../../shared/engine/adapter';
import type { AgentEvent, SendKind } from '../../shared/engine/events';
import type {
  EmployeeContext,
  EngineCapabilities,
  ProbeResult,
  Usage,
} from '../../shared/engine/types';
import {
  EngineNotInstalledError,
  EngineApiKeyRequiredError,
  EngineHookNotRunningError,
  EngineProbeIndeterminateError,
  PROBE_LIVENESS_CEILING_MS,
} from '../../shared/engine/types';
import type { SecretBroker } from '../../shared/engine/seams';
import type { EngineMode } from '../../shared/models/enums';
import {
  getEmployeeById,
  setEmployeeStatus,
  setEmployeeSessionId,
  setEmployeeHeartbeat,
  setEmployeeConsecutiveFailures,
  setEmployeeResumeAt,
  recordEmployeeResolvedModel,
} from '../db/repositories/employees';
import { markMessageConsumed } from '../db/repositories/messages';
import type { OutboxMessage } from '../../shared/models/message';
import { insertUsage } from '../db/repositories/usage';
import { insertCheckpoint } from '../db/repositories/checkpoints';
import { blockTaskForCheckpoint } from '../checkpoints/taskBlocking';
import { setTaskStatus } from '../db/repositories/tasks';
import { nowIso } from '../../shared/models/ids';
import { getEmployeeStateDir } from '../db/paths';
import { getSetting } from '../db/repositories/settings';
import { TerminalBroadcaster, type TerminalBroadcasterOptions } from './terminalBroadcaster';
import type { TokenRegistry } from '../controlChannel/tokens';
import type { SupervisorRegistry } from './supervisorRegistry';
import { refuseSpawnIfZeroCost, ZeroCostSpawnRefusedError } from '../cost/zeroCostMode';
import { computeCostFromTokens } from '../cost/pricingYaml';
import { resolveModelTier } from './modelTiers';
import { checkEngineVersionDrift } from './engineVersionDrift';
import { isAnthropicApiKeyStored } from '../secrets/anthropicKeyPresence';
import { syncMemoryIndexFromDisk } from '../memory/syncMemoryIndex';
import { composeMemoryPack, memoryInjectedPayload, renderMemoryPack } from '../memory/memoryPack';
import { enforceBudget } from '../cost/budgetEnforcement';
import {
  backoffDelayMs,
  resolveResumeAt,
  buildQuotaExhaustedCheckpointText,
} from '../cost/rateLimitHandling';
import type { PricingTable } from '../../shared/models/pricing';
import { LoopDetector } from '../controlChannel/policy/loopDetector';
import {
  pruneAndSumTokens,
  STEER_MESSAGE,
  buildBreakerBlockerCheckpointInput,
  type BreakerTrigger,
  type TimestampedTokens,
} from './circuitBreaker';
import { RedactionStream } from '../secrets/redactor';
import { ProbeCache, globalProbeCache } from './probeCache';

/** §11.4: a second, independent release trigger for the raw-stream
 * redaction buffer, alongside `idle` — a stall mid-turn (no `idle` event
 * for a while, but also no new chunk) must not leave the terminal frozen
 * on its held-back tail indefinitely. See `RedactionStream.flush()`'s own
 * doc comment for the risk this trades and why. */
const REDACTION_INACTIVITY_MS = 300;

/** §11.5's `breaker.tokensPerMinute` — "per minute" already IS the
 * window; no separate window setting exists or is needed. */
const TOKEN_VELOCITY_WINDOW_MS = 60_000;

/** M11 hook liveness: how long after the handshake exits a late report is
 *  still accepted. The hook answers before the CLI exits, so this only covers
 *  the loopback round trip. */
const HOOK_REPORT_GRACE_MS = 2_000;

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
 * §11.4/M6 session 3: text handed to `write()` has already passed through
 * `RedactionStream` at `handleEvent`'s `case 'raw':` (the same instance
 * feeding `this.terminal.feed()`) — this interface never sees a raw
 * secret, not because it does its own filtering, but because nothing
 * upstream of it ever calls it with unredacted text.
 */
export interface TranscriptWriter {
  write(employeeId: string, chunk: string): Promise<void>;
}

/**
 * `baseDir` is the same Electron userData root `getDbPaths`/`reconcile()`
 * take — files land under each employee's own `getEmployeeStateDir`
 * directory (`transcript.log`), the same per-employee layout convention
 * `bureau_state` already uses, rather than a flat `<baseDir>/<id>.
 * transcript.log`. This is what `system.ts`'s real `supportBundle`
 * handler (M6 session 3) scans for "each currently-tracked employee's
 * transcript tail" — one canonical location, not two conventions to keep
 * in sync.
 */
export function createFileTranscriptWriter(baseDir: string): TranscriptWriter {
  return {
    async write(employeeId: string, chunk: string): Promise<void> {
      const dir = getEmployeeStateDir(baseDir, employeeId);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.appendFile(path.join(dir, 'transcript.log'), chunk);
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
  /**
   * M11 row S1-13: sees every event the engine emits, in order, before this
   * Supervisor acts on it — the Director's chat producer listens here. An
   * observer only: it cannot change what the Supervisor does, and a throw
   * from it is contained (logged), never allowed to stop the event loop.
   */
  onAgentEvent?: (event: AgentEvent) => void;
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
  /**
   * M6 session 2 — loaded ONCE at app startup (`loadPricingYaml(
   * resolvePricingYamlPath())`) and injected here, not re-read from disk
   * per turn. `null`/omitted means cost cannot be computed from tokens at
   * all (falls back to whatever the engine itself reported, honestly
   * null if that's also absent) — never a crash, matching every other
   * "missing pricing data" case in this session.
   */
  pricing?: PricingTable | null;
  /**
   * M7 session 2. `probe()` spawns a real process against §7.1's hard 5s
   * deadline, and installed version / auth status are properties of the
   * MACHINE, not of the employee asking — so N employees should not mean
   * N process spawns. Defaults to the process-wide cache; tests pass
   * their own so state does not leak between them.
   */
  probeCache?: ProbeCache;
  /**
   * P-3 (chaos #10): the monotonic clock durations are measured on.
   * `performance.now()` by default; injectable for the clock-jump test.
   */
  monotonicNow?: () => number;
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
  private readonly onAgentEvent: ((event: AgentEvent) => void) | null;
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
  /** M6 session 2 — resolved from `ctx.task.project_id` at assign() time,
   * the same lifecycle as `currentTaskId`. `usage` has no `project_id`
   * column of its own; this is what the transactional write path
   * (recordUsage) uses to update `projects.spend_usd_micros`. Null for
   * the Director (no task) and for any employee between assignments —
   * the write path skips the `projects` UPDATE in that case rather than
   * guessing which project to attribute spend to. */
  private currentProjectId: string | null = null;
  private readonly tokenRegistry: TokenRegistry | null;
  private readonly supervisorRegistry: SupervisorRegistry | null;
  /**
   * M6 session 2 (§28 M6 session 1's own Fix B): cached once per
   * assign(), not re-fetched per call — `probe()` is real I/O (a `claude
   * auth status` subprocess spawn), and this feeds the policy evaluator's
   * hot path (one lookup per tool call) as well as cost/budget logic.
   * Null until assign() has run; both null-handling paths already fail
   * toward the safe direction (classifyTool -> 'other' -> deny;
   * usageReporting unknown -> wall-clock-only enforcement), not a crash.
   */
  private probeResult: ProbeResult | null = null;
  private capabilities: EngineCapabilities | null = null;
  private readonly probeCache: ProbeCache;
  private readonly monotonicNow: () => number;
  /** M6 session 2, item 8 — resolved from `ctx.employee`/`ctx.role` at
   * assign() time, same lifecycle as `currentTaskId`/`currentProjectId`.
   * `isDirector` decides whether the Director's reserve carve-outs and
   * `perEmployeeDailyUsd` exemption apply (budgetEnforcement.ts's own
   * job); the two budget overrides fall back to the matching global
   * setting when null (role/employee never configured one). */
  private isDirector = false;
  private roleBudgetMicros: number | null = null;
  private employeeDailyBudgetMicros: number | null = null;
  private readonly pricing: PricingTable | null;
  /** M6 session 2, item 9 — the last thing actually sent via `adapter.send()`
   * from this class's own code (currently only `assign()`'s task-body
   * delivery), kept so a per-minute rate-limit retry can resend the exact
   * same content. A real, honest limitation, not hidden: nothing else in
   * this codebase yet calls `adapter.send()` from Supervisor for a later
   * turn (no message-history/context-resend mechanism exists before the
   * Director, M11) — a rate limit hit deep into a multi-turn conversation
   * has nothing beyond the original task body to replay. */
  private lastSentText: string | null = null;
  private lastSentKind: SendKind | null = null;
  /** §24.3's own state for the per-minute backoff loop — reset on a genuine
   * escalation to exhausted (`clearRateLimitRetry`), never on an ordinary
   * turn, so `rateLimitMaxWaitMinutes` is measured from the FIRST
   * rate-limited response in a cluster, not restarted by each retry. */
  private rateLimitAttempt = 0;
  private rateLimitWaitStartedAt: number | null = null;
  private rateLimitRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set for the duration of one rate-limited cycle — consulted (and
   * cleared) by `handleFinished` so the underlying process's own exit
   * (which follows almost immediately, structured mode's `child.on('exit')`
   * with a non-zero code) is never treated as a crash. §24.3: "Never let a
   * rate limit look like a crash." */
  private rateLimitedThisCycle = false;
  /** M6 session 3 — §11.4: the real credential resolver, stored from
   * `ctx.broker` at assign() time so `stop()` can call
   * `revokeForEmployee()` on every real exit path that has one (see
   * `stop()`'s own comment). `null` until assign() has run. */
  private broker: SecretBroker | null = null;
  /** M6 session 3, item 10 — the circuit breaker's own state. Settings
   * are cached once at assign() (matching every other per-employee
   * setting this class already caches), not re-read per check. */
  private breakerEnabled = false;
  private breakerTokensPerMinute = 200_000;
  private breakerErrorStormLimit = 8;
  private breakerSteerTimeoutS = 120;
  private breakerHardStop = false;
  /** `role.wall_clock_timeout_s` (M1, already existed — confirmed
   * unconsumed anywhere but the lease-TTL calculation before this
   * session) — the wall-clock-overrun trigger's own threshold. */
  private wallClockTimeoutS = 2400;
  /** N-16: what wall-clock-overrun is measured from. An employee's clock runs from
   *  `assign()` (one task, one assignment). The Director's session lives
   *  for days and is idle most of that time, so its clock runs from the
   *  current turn's `turn.started` and is cleared at `idle`. Measured
   *  from `assign()`, it tripped about 40 minutes into the app's life. */
  private wallClockStartedAt: number | null = null;
  /** S-3: monotonic ms when the employee last entered `idle`; null otherwise. */
  private idleSinceMs: number | null = null;
  /** S-3: `orchestrator.idleStopMinutes`, read at assign. 0 disables idle-stop. */
  private idleStopMinutes = 0;
  private tokenVelocityWindow: TimestampedTokens[] = [];
  /** A second, Supervisor-owned `LoopDetector` instance for the
   * error-storm trigger — genuine reuse of the existing generic
   * sliding-window primitive (session 1's own `LoopDetector` class),
   * NOT the same instance the policy layer's own repeated-tool-call
   * detection owns (that one stays exactly where it is). Reuses
   * `breaker.repeatedToolWindowS` as its window — no dedicated
   * error-storm-window setting exists in schema.ts, flagged in
   * PROGRESS.md as a real, reasonable reuse. */
  private errorStormDetector: LoopDetector | null = null;
  private breakerTripped = false;
  /** `isBreakerConstrained()` — `policyEvaluator.ts` reads this via
   * `SupervisorRegistry` (the same live-Supervisor-state pattern Fix B,
   * M6 session 2, already established for capabilities) to force
   * `effectiveAutonomy` to `'ask'`. NEVER written to `employees.autonomy`
   * — "computed, not persisted" (CLAUDE.md's own named trap) holds
   * exactly as before; this is one more live input to that computation. */
  private breakerConstrained = false;
  private breakerEscalationTimer: ReturnType<typeof setTimeout> | null = null;
  /** §11.4 choke points 1+2/6 — one stream instance per Supervisor,
   * feeding both `writeTranscript()` and `this.terminal.feed()` from the
   * same already-redacted output (see `handleEvent`'s `case 'raw':`). */
  private readonly redactionStream = new RedactionStream();
  private redactionInactivityTimer: ReturnType<typeof setTimeout> | null = null;
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
  /**
   * M8 session 2, §9.7 — outbox messages this Supervisor has handed to its
   * adapter and that the employee has not yet started a turn with.
   *
   * §9.7: "The employee marks it `consumed` implicitly when its next turn
   * starts — **the supervisor records this, not the agent**." So the ids
   * wait here, in memory, until a real `turn.started` proves the employee
   * actually picked the message up. An agent reporting its own consumption
   * would not be evidence, which is why there is no tool for it.
   *
   * **What a process death in this window means, stated plainly:** the row
   * stays `delivered` with `consumed_at IS NULL` forever. That is not a
   * silent loss — `routeOnce`'s `requeueUnconsumedDeliveries` reads exactly
   * that state on the next start and puts the message back on the queue,
   * which is `consumed_at`'s real reader and the reason it is not a
   * write-only column.
   */
  private deliveredAwaitingConsumption: string[] = [];

  constructor(
    readonly employeeId: string,
    options: SupervisorOptions,
  ) {
    this.db = options.db;
    this.activityLog = options.activityLog;
    this.adapter = options.adapter;
    this.transcriptWriter = options.transcriptWriter ?? null;
    this.onAgentEvent = options.onAgentEvent ?? null;
    this.heartbeatConfig = { ...DEFAULT_HEARTBEAT_CONFIG, ...options.heartbeat };
    this.heartbeatCheckIntervalMs = options.heartbeatCheckIntervalMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.terminal = new TerminalBroadcaster(employeeId, options.terminalBroadcaster);
    this.tokenRegistry = options.tokenRegistry ?? null;
    this.supervisorRegistry = options.supervisorRegistry ?? null;
    this.pricing = options.pricing ?? null;
    this.probeCache = options.probeCache ?? globalProbeCache;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
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

  /**
   * §9.7's delivery step — `adapter.send(body, 'message')`, and the only
   * way an outbox message reaches a running employee.
   *
   * The router has already established that this employee is at a turn
   * boundary; `send()` carries §7.4's own queue underneath as the backstop
   * for the race if that flips in between, so nothing here can inject text
   * mid-generation (CLAUDE.md's named trap). `send()` is awaited so a
   * genuine failure propagates to the router's retry ladder rather than
   * being swallowed into a message that looks delivered.
   *
   * The message id is remembered, not marked consumed — see
   * `deliveredAwaitingConsumption`.
   */
  async deliverOutboxMessage(message: OutboxMessage): Promise<void> {
    await this.adapter.send(renderOutboxMessage(message), 'message');
    this.deliveredAwaitingConsumption.push(message.id);
  }

  get currentState(): SupervisorState {
    return this.state;
  }

  get turnsCompleted(): number {
    return this.turnCount;
  }

  /** M6 session 2, Fix B: the real `ProbeResult` this employee's process
   * is actually running under, cached from `assign()`. `null` until
   * assign() has run — the policy evaluator and cost/budget code both
   * treat that as "unknown", never as "definitely free"/"definitely
   * allowed". */
  getProbeResult(): ProbeResult | null {
    return this.probeResult;
  }

  /** The real, probe-and-mode-aware capabilities for this employee's
   * engine — replaces `toolClassify.ts`'s old fabricated-probe lookup.
   * `null` until assign() has run. */
  getCapabilities(): EngineCapabilities | null {
    return this.capabilities;
  }

  getMode(): EngineMode {
    return this.mode;
  }

  /** M6 session 3, item 10 — true once the circuit breaker has tripped
   * and moved to the "constrain" step (§11.5). `policyEvaluator.ts`
   * reads this to force `effectiveAutonomy` to `'ask'` for this
   * employee's next tool call. */
  isBreakerConstrained(): boolean {
    return this.breakerConstrained;
  }

  /** §11.5 — the repeated-identical-tool-call trigger. Called externally
   * from `server.ts`'s `handlePolicyCheck`, exactly where session 1's own
   * `tool.loop_detected` is already logged — session 1's `LoopDetector`
   * is CONSUMED here, not rebuilt; this method is the one real thing this
   * class adds on top of that signal. */
  noteLoopDetected(): void {
    this.tripBreaker('repeated_tool_calls', {});
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
    this.currentProjectId = ctx.task?.project_id ?? null;
    this.isDirector = ctx.employee.is_director;
    this.roleBudgetMicros = ctx.role.budget_usd_micros;
    this.employeeDailyBudgetMicros = ctx.employee.daily_budget_usd_micros;
    this.mode = (ctx.role.engine_options?.mode ?? 'auto') === 'pty' ? 'pty' : 'structured';
    this.broker = ctx.broker;

    // §7.5 (AUDIT #1) — resolve the role's declared abstract tier to one
    // concrete model id, here, where the settings DB is actually reachable.
    // Adapters get told the answer; they never resolve tiers themselves.
    //
    // The parameter is deliberately reassigned rather than shadowed by a
    // second local: every later use in this method then picks the resolved
    // context up automatically. A second variable would leave the original
    // `ctx` in scope for one of them to keep using by accident — which is
    // precisely the class of silent gap this finding came from.
    // The employee's own tier choice wins over the role's when it is set
    // (§7.5, migration 0008). NULL — the normal case — falls through to
    // the role's `model_preference` exactly as before.
    //
    // This is the ONLY place a model is decided. `hireEmployee` used to
    // decide one too and store the resolved id; the two disagreed and the
    // spawn silently won, which is the M7→M4 boundary check's finding.
    // Hiring now records the CHOICE (a tier) and this resolves it.
    const modelPreference = ctx.employee.model_tier_override
      ? [ctx.employee.model_tier_override]
      : ctx.role.model_preference;
    const resolvedTier = resolveModelTier({
      modelPreference,
      // The EMPLOYEE's declared engine, not `this.adapter.key`: §7.5's map
      // is keyed on the engine an employee is configured to run under, so
      // resolution stays a pure function of persisted state (role +
      // employee + settings) rather than of which adapter instance
      // happened to be injected.
      engineKey: ctx.employee.engine,
      configured: getSetting(this.db, 'engines.modelTiers'),
    });
    // Record what actually launched, so "which model is this employee on"
    // is answerable. A record, never an input — see the repository
    // function's own comment for why writing it anywhere else would
    // recreate the bug this replaced.
    recordEmployeeResolvedModel(this.db, this.employeeId, resolvedTier?.modelId ?? null);
    ctx = {
      ...ctx,
      modelId: resolvedTier?.modelId ?? null,
      // §11.5.1: a per-turn backstop, set to the whole task's ceiling so
      // §11.5's own cumulative levels always bind first. See the field's
      // doc comment on EmployeeContext for why this is not "the budget".
      turnBudgetCapUsdMicros: this.roleBudgetMicros ?? getSetting(this.db, 'budgets.perTaskUsd'),
    };

    // §11.5, item 10 — the breaker's own per-employee state, reset fresh
    // for this assignment (a restart/new task both start clean; see
    // PROGRESS.md for why an in-memory reset here is safe against a real
    // app restart specifically — reconcile()'s own crash-recovery covers
    // that window independently).
    this.wallClockTimeoutS = ctx.role.wall_clock_timeout_s;
    this.wallClockStartedAt = this.isDirector ? null : Date.now();
    this.breakerTripped = false;
    this.breakerConstrained = false;
    this.tokenVelocityWindow = [];
    if (this.breakerEscalationTimer) {
      clearTimeout(this.breakerEscalationTimer);
      this.breakerEscalationTimer = null;
    }
    this.breakerEnabled = getSetting(this.db, 'breaker.enabled');
    this.breakerTokensPerMinute = getSetting(this.db, 'breaker.tokensPerMinute');
    this.breakerErrorStormLimit = getSetting(this.db, 'breaker.errorStormLimit');
    this.breakerSteerTimeoutS = getSetting(this.db, 'breaker.steerTimeoutS');
    this.breakerHardStop = getSetting(this.db, 'breaker.hardStop');
    this.idleStopMinutes = getSetting(this.db, 'orchestrator.idleStopMinutes');
    const repeatedToolWindowS = getSetting(this.db, 'breaker.repeatedToolWindowS');
    this.errorStormDetector = new LoopDetector({
      limit: this.breakerErrorStormLimit,
      windowMs: repeatedToolWindowS * 1000,
    });

    // §7.8: probe() never throws and finishes within the budget this call
    // gives it — safe to call inline. Cached for this employee's whole
    // lifetime (getCapabilities/getProbeResult below), not re-derived per
    // tool call or per turn.
    //
    // M7 session 2: also cached ACROSS employees, because the per-employee
    // cache was never the problem. N employees spawning N `claude
    // --version` processes to learn the same machine-level fact is what
    // pushed one probe to 5064ms against the then-5s deadline, and hiring is
    // the milestone that makes N large. Single-flight, so a burst of
    // concurrent assigns collapses to one spawn rather than N.
    //
    // **The budget is the ceiling, not the responsiveness bound (§7.8).**
    // Nobody is watching a spinner on this path: `assign()` is machinery
    // between a hire and a running employee, and the difference between it
    // taking 1.8s and 4.4s is invisible. What is emphatically not invisible
    // is refusing to spawn an employee because a cold CLI took 3 seconds to
    // report its own version. This caller can afford to wait for the right
    // answer, so it does.
    this.probeResult = await this.probeCache.probe(this.adapter, {
      budgetMs: PROBE_LIVENESS_CEILING_MS,
    });

    // §7.8 / invariant #6: refuse rather than spawn on an answer the probe
    // never actually reached. Fail-closed behaviour is unchanged — an
    // indeterminate probe would have carried `installed: false` and
    // `metered: true` and been refused downstream regardless — but the
    // reason given is now the true one. "claude-code is not installed" sends
    // the user to reinstall a CLI that is sitting right there; naming the
    // budget sends them to try again, which is the action that works.
    //
    // No new activity event, deliberately. This path makes no state change —
    // it throws before `transition('starting')` — so invariant #3 is not
    // engaged, and adding a §5.2 event type is a spec amendment this fix did
    // not need. `ZeroCostSpawnRefusedError` emits one because §24.5 names
    // `cost.zero_cost_blocked` specifically; nothing names this.
    if (this.probeResult.determination === 'indeterminate') {
      throw new EngineProbeIndeterminateError(
        `Could not confirm ${this.adapter.key} is installed and usable within ${PROBE_LIVENESS_CEILING_MS}ms — refusing to spawn on an unverified engine. This is not a report that the engine is missing: the check did not complete (${this.probeResult.error ?? 'no further detail'}).`,
      );
    }

    // P-2 (NEXT-VERSION §H.9): a DETERMINED absence is refused here too, before
    // `transition('starting')`, instead of reaching `start()` and failing at
    // the spawn with the resolver's own wording. No state change, so no event
    // (the same reasoning as the indeterminate refusal above).
    if (!this.probeResult.installed) {
      throw new EngineNotInstalledError(
        `Bureau can't start this employee because ${this.adapter.key} isn't installed on this computer. Install it, then try again.`,
      );
    }

    // M11 S1-7 / risk #34 (E-4a): a real claude-code launch needs a stored
    // API key. Keyed on the ADAPTER, not on `employee.engine`: the question
    // is whether the thing about to run will really launch the CLI, and a
    // FakeAdapter standing in for a claude-code employee will not. Refused
    // here, with the other pre-spawn refusals, before `transition('starting')`
    // — so no state change, and no event, for the same reason they emit none.
    if (this.adapter.key === 'claude-code' && !isAnthropicApiKeyStored(this.db)) {
      throw new EngineApiKeyRequiredError(
        'Bureau needs an Anthropic API key before it can start this employee. Add one in ' +
          'Settings → Engines → Anthropic API key. (Bureau runs employees on an API key, not on ' +
          'your Claude subscription.)',
      );
    }

    this.capabilities = this.adapter.capabilities(this.probeResult, this.mode);

    // §7.8 test 10 / §27 risk 15 (AUDIT #6): the real probe's real version
    // against this build's tested pin. Detection only — it cannot make a
    // changed output format safe, and §27 risk 15 says so.
    const drift = checkEngineVersionDrift(this.adapter.key, this.probeResult.version);
    if (drift) {
      this.activityLog.logEvent({
        actor: 'system',
        type: 'employee.engine_version_drift',
        severity: 'warn',
        project_id: this.currentProjectId,
        task_id: this.currentTaskId,
        employee_id: this.employeeId,
        checkpoint_id: null,
        payload: {
          engine: drift.engineKey,
          reportedVersion: drift.reportedVersion,
          testedVersions: drift.testedVersions,
        },
      });
    }

    // §24.5: refused BEFORE any spawn, using the real probe this employee
    // is actually about to run under — never a fabricated one. Emits
    // cost.zero_cost_blocked and throws rather than silently no-op-ing;
    // the caller (whatever eventually drives real hiring — no live
    // caller until M11) is expected to surface this, not swallow it.
    const zeroCostModeEnabled = getSetting(this.db, 'costs.zeroCostMode');
    const refusal = refuseSpawnIfZeroCost(zeroCostModeEnabled, this.probeResult);
    if (refusal.refused) {
      this.activityLog.logEvent({
        actor: 'system',
        type: 'cost.zero_cost_blocked',
        severity: 'warn',
        project_id: this.currentProjectId,
        task_id: this.currentTaskId,
        employee_id: this.employeeId,
        checkpoint_id: null,
        payload: { reason: refusal.reason, engine: this.adapter.key },
      });
      throw new ZeroCostSpawnRefusedError(refusal.reason ?? 'zero-cost mode refused this spawn');
    }

    // M11 hook liveness (§7.6): where the policy gate is a hook, the CLI
    // proves it runs that hook before anything starts. Refused here with
    // the other pre-spawn refusals, before `transition('starting')`: no
    // state change, so no event, and the error is the one thing the caller
    // shows (startDirector writes it into the chat). The handshake is a
    // launch like the probe's `--version`: verification, with no model call.
    const hookSessionId = this.capabilities.hookInterception
      ? await this.confirmHookLiveness(ctx)
      : null;

    this.transition('starting', ctx.task?.id ?? null);
    // M11 row S1-10: the adapter asks before flushing anything queued, and
    // the answer is this Supervisor's own state — one place, not a second
    // copy of "may we spend now" inside the adapter.
    this.adapter.setDeliveryGate?.(() => this.mayDeliverNow());
    await this.adapter.start(ctx);

    // M11 row S1-11, §8.0: "one persistent session per company, resumed by
    // session_id across restarts". The id the engine last reported is on
    // the employee row; an engine that cannot resume, or refuses this id,
    // starts fresh and says so rather than pretending continuity.
    const storedSessionId = ctx.employee.session_id;
    if (storedSessionId !== null && this.capabilities?.sessionResume === true) {
      const resumed = await this.adapter.resume(storedSessionId, ctx);
      this.lastPersistedSessionId = resumed ? storedSessionId : null;
      if (!resumed) {
        setEmployeeSessionId(this.db, this.employeeId, null);
        this.activityLog.logEvent({
          actor: 'system',
          type: 'director.session_restarted',
          severity: 'info',
          project_id: this.currentProjectId,
          task_id: this.currentTaskId,
          employee_id: this.employeeId,
          checkpoint_id: null,
          payload: { reason: 'resume_refused', previousSessionId: storedSessionId },
        });
      }
    }

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
      // `hookSessionId`: the session the liveness hook reported, or null
      // for an engine whose gate is not a hook.
      payload: { envKeys: Object.keys(spec.env), hookSessionId },
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
    // ## The memory pack (M10, §12.3)
    //
    // §12.3: "**On task assignment, the supervisor composes** a memory
    // pack." This is that assignment, and this class is that supervisor —
    // which is why composition happens here rather than being handed in.
    // `EmployeeContext` used to carry `memoryPack`/`decisionLog` as
    // caller-supplied strings that nothing ever read: a write-only decision
    // input, the exact tell standing rule 6 names, and the same shape as the
    // model-tier bug the M7->M4 boundary check found. Both fields are gone.
    //
    // **Scope discipline still applies, and is narrower than it looks.**
    // Appendix B's employee prompt has six slots; M10 owns two of them
    // (`{{decision_log}}` and `{{memory_pack}}`, both filled from one
    // composition because each pack item carries its own `kind`). The role
    // prompt, the acceptance criteria and the brief summary are M11's, and
    // nothing here pretends to assemble them.
    if (ctx.task) {
      const text = this.composeTaskMessage(ctx);
      this.lastSentText = text;
      this.lastSentKind = 'task';
      await this.adapter.send(text, 'task');
    }
  }

  /**
   * The task body, with §12.3's memory pack in front of it, and the
   * `memory.injected` event that records what went in.
   *
   * The event is emitted **before** the send, per invariant #3 — the state
   * change is committed, then the side effect. Its payload is the fact list
   * (paths, ids, token estimates), never the rendered text: §12.3's stated
   * purpose is that *"what did the agent know?"* is always answerable, and a
   * blob of markdown inside an event answers nothing you can query.
   *
   * A pack that came back empty emits nothing and prepends nothing. Nothing
   * was injected, so there is no state change to record — and an event
   * saying "0 notes" on every assignment would turn the trail into a log of
   * when we looked.
   */
  private composeTaskMessage(ctx: EmployeeContext): string {
    const task = ctx.task;
    if (task === null) return '';

    // Layer 1 is the source of truth and a person may have edited it since
    // the index was last built (§12.1). Cheap by construction: the
    // reconciler stats before it hashes, so an unchanged tree opens no
    // files.
    syncMemoryIndexFromDisk(this.db, ctx.baseDir, this.activityLog);

    const pack = composeMemoryPack(this.db, {
      role: ctx.role,
      projectId: task.project_id,
      // The task's own text, raw. `toFtsQuery` is what makes it safe to put
      // in front of FTS5, and it already exists — a title containing `-` or
      // `NEAR` must not become a different query or a syntax error.
      taskText: `${task.title}\n${task.body}`,
    });

    if (pack.items.length === 0) return task.body;

    this.activityLog.logEvent({
      actor: 'system',
      type: 'memory.injected',
      severity: 'info',
      project_id: task.project_id,
      task_id: task.id,
      employee_id: this.employeeId,
      checkpoint_id: null,
      payload: memoryInjectedPayload(pack),
    });

    return `${renderMemoryPack(pack)}\n\n---\n\n${task.body}`;
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
    // M11 row S1-13: observers first, and outside the parked gate below: a
    // turn that finishes while parked still ends the reply it was streaming.
    if (this.onAgentEvent !== null) {
      try {
        this.onAgentEvent(event);
      } catch (err) {
        console.error('[supervisor] an agent-event observer threw:', err);
      }
    }
    // §11.5 / AUDIT #8: `parked` is a GATE, not a label. Once an employee
    // is parked — a blown budget, an exhausted quota — nothing the engine
    // still emits may put it back to work or bill another turn. Before
    // this, `case 'turn.started'` transitioned to 'working'
    // unconditionally and `transition()` had no terminal guard, so a
    // parked employee whose adapter emitted one more turn silently
    // resumed and kept spending: `enforceBudget` does not re-fire, because
    // the threshold check only triggers on the turn that CROSSES the
    // limit.
    //
    // Deliberately here and not inside `transition()`: `assign()`
    // legitimately transitions a previously-parked employee back to
    // 'starting' once the resume tick promotes it (§24.3). It is the
    // ENGINE's events that must not, not every caller.
    //
    // N-1: the park gates STATE TRANSITIONS, not ACCOUNTING. claude-code
    // cannot be interrupted, so a turn in flight when a park or a user pause
    // lands really finishes and really costs money. Its usage is recorded
    // (ledger row, counters, `cost.turn_recorded`); every event that would
    // move the employee is still refused.
    if (this.state === 'parked') {
      if (event.t === 'turn.completed') this.recordUsage(event.turnIndex, event.usage);
      return;
    }

    switch (event.t) {
      case 'session.started': {
        // M11 row S1-11: the id the engine actually started, persisted so
        // the next launch can resume it. No event of its own — this is the
        // same state change the transition below already records, and it
        // carries the id.
        const sessionId = event.sessionId;
        if (sessionId !== null && sessionId !== this.lastPersistedSessionId) {
          setEmployeeSessionId(this.db, this.employeeId, sessionId);
          this.lastPersistedSessionId = sessionId;
          this.transition('idle', this.currentTaskId, { sessionId });
          break;
        }
        this.transition('idle', this.currentTaskId);
        break;
      }
      case 'turn.started':
        // §7.11/M3 session 3 correction 2: the ONE place turnCount
        // increments — see recordTurnStarted's own comment for why this
        // replaced two separate, disagreeing mechanisms.
        this.recordTurnStarted();
        // §9.7 — a turn starting IS the employee consuming whatever was
        // delivered to it, and this is the supervisor recording that.
        this.recordMessageConsumption();
        if (this.isDirector) this.wallClockStartedAt = Date.now();
        this.transition('working', this.currentTaskId);
        break;
      case 'text.delta':
      case 'thinking.delta':
        this.transition('working', this.currentTaskId);
        break;
      case 'raw': {
        // §11.4 choke points 1+2/6: redacted ONCE here, upstream of both
        // sinks — the transcript writer and the live xterm.js broadcaster
        // used to each receive the same raw, unredacted bytes
        // independently; now both receive the same already-safe output
        // from one `RedactionStream` instance. Not itself a state
        // transition; readiness (idle) comes from the adapter's own
        // PtySession-driven idle detection, which surfaces as an 'idle'
        // event exactly like structured mode's (handled below, which is
        // also this stream's primary flush trigger).
        const safeText = this.redactionStream.feed(event.data.toString('utf8'));
        if (safeText.length > 0) {
          void this.writeTranscript(safeText);
          this.terminal.feed(Buffer.from(safeText, 'utf8'));
        }
        // A stall mid-turn (no `idle` for a while, but also no new chunk)
        // must not leave the held-back tail frozen indefinitely — see
        // `RedactionStream.flush()`'s own doc comment for the risk this
        // trades. Reset on every chunk; only the LAST one before a real
        // quiet stretch actually fires.
        if (this.redactionInactivityTimer) clearTimeout(this.redactionInactivityTimer);
        this.redactionInactivityTimer = setTimeout(
          () => this.flushRedactionStream(),
          REDACTION_INACTIVITY_MS,
        );
        break;
      }
      case 'tool.requested':
        // No real gate exists yet (M4/M6) — capabilities().hookInterception
        // and permissionCallback are both false (session 2 part 1), so
        // nothing actually resolves this to allow/deny today. Reflects the
        // *shape* of §7.11's transition without pretending gating happens.
        this.transition('thinking', this.currentTaskId);
        break;
      case 'tool.completed':
        this.transition('working', this.currentTaskId);
        if (!event.ok) this.noteToolFailure();
        break;
      case 'idle':
        // §11.4: idle is ALSO the redaction stream's own primary release
        // point — "at a prompt, safe to inject" is equally "safe to stop
        // holding back" (see RedactionStream.flush()'s own doc comment).
        this.flushRedactionStream();
        if (this.isDirector) this.wallClockStartedAt = null;
        this.transition('idle', this.currentTaskId);
        break;
      case 'turn.completed':
        this.recordUsage(event.turnIndex, event.usage);
        break;
      case 'finished':
        this.handleFinished(event.reason, event.summary);
        break;
      case 'rate_limited':
        this.handleRateLimited(event.classification, event.retryAfterMs);
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
   * §9.7's `consumed` transition. One state change per message, one
   * `message.consumed` event each (invariant #3) — not one event for the
   * batch, because each row's status changes independently and a consumer
   * filtering by `message_id` would otherwise see nothing for four of five.
   */
  private recordMessageConsumption(): void {
    if (this.deliveredAwaitingConsumption.length === 0) return;
    const consumed = this.deliveredAwaitingConsumption;
    this.deliveredAwaitingConsumption = [];
    const at = nowIso();

    for (const messageId of consumed) {
      markMessageConsumed(this.db, messageId, at);
      this.activityLog.logEvent({
        actor: 'system',
        type: 'message.consumed',
        severity: 'info',
        project_id: null,
        task_id: this.currentTaskId,
        employee_id: this.employeeId,
        checkpoint_id: null,
        payload: { messageId },
      });
    }
  }

  /**
   * PTY mode never emits `turn.completed` at all (§7.7.1: there is no
   * usage signal to attach to one), so this only ever fires for
   * structured mode's real, engine-reported usage.
   *
   * M6 session 2: extends this exact seam — the real write path
   * (`insertUsage`'s own transaction) and, on the same real counters it
   * just updated, real budget enforcement (`enforceBudget`). Still one
   * seam, not a second usage path: everything downstream (the write, the
   * cost resolution, the budget check) hangs off this one method, the
   * same one session 1's own "visibility only, M6 does enforcement"
   * comment pointed at.
   */
  private recordUsage(turnIndex: number, usageEvent: Usage | null): void {
    if (!usageEvent) return;

    // §11.5, item 10 — the token-velocity trigger. Fed from real usage
    // regardless of whether a cost could be computed from it (velocity
    // is about tokens, not dollars — an unreported-cost engine still
    // reports real token counts here).
    this.noteTokenUsage((usageEvent.tokensIn ?? 0) + (usageEvent.tokensOut ?? 0));

    // §11.5.1's own design question, resolved: the engine's own reported
    // cost is authoritative when present (it accounts for volume tiers/
    // promotions a static rate table can't); Bureau's own pricing.yaml
    // estimate is ALWAYS computed when possible (never discarded — see
    // migration 0005's own comment) and used as the authoritative figure
    // only when the engine reported none.
    const computedCostMicros = this.pricing
      ? computeCostFromTokens(this.pricing, this.adapter.key, usageEvent.model, {
          tokensIn: usageEvent.tokensIn,
          tokensOut: usageEvent.tokensOut,
          tokensCacheRead: usageEvent.tokensCacheRead,
          tokensCacheWrite: usageEvent.tokensCacheWrite,
        })
      : null;
    const costMicros = usageEvent.costUsdMicros ?? computedCostMicros;

    const { usage, taskSpend, projectSpend } = insertUsage(
      this.db,
      {
        employee_id: this.employeeId,
        task_id: this.currentTaskId,
        engine: this.adapter.key,
        model: usageEvent.model,
        tokens_in: usageEvent.tokensIn,
        tokens_out: usageEvent.tokensOut,
        tokens_cache_read: usageEvent.tokensCacheRead,
        tokens_cache_write: usageEvent.tokensCacheWrite,
        cost_usd_micros: costMicros,
        computed_cost_usd_micros: computedCostMicros,
        turn_index: turnIndex,
        source: 'turn',
      },
      { projectId: this.currentProjectId },
    );
    this.activityLog.logEvent({
      actor: 'system',
      type: 'cost.turn_recorded',
      severity: 'info',
      project_id: this.currentProjectId,
      task_id: this.currentTaskId,
      employee_id: this.employeeId,
      checkpoint_id: null,
      payload: {
        usageId: usage.id,
        costUsdMicros: costMicros,
        computedCostUsdMicros: computedCostMicros,
      },
    });

    // Nothing to enforce against when this turn's cost is genuinely
    // unknown (an unreported-usage engine with no pricing.yaml rate
    // either) — wall-clock/turn-count limits are the only real
    // enforcement possible for those, matching §11.5.1's own honesty
    // rule; this function never fabricates a 0 to force a budget check.
    if (costMicros === null) return;

    const { verdict, mostSevereLevel } = enforceBudget(this.db, this.activityLog, {
      employeeId: this.employeeId,
      isDirector: this.isDirector,
      projectId: this.currentProjectId,
      taskId: this.currentTaskId,
      costMicros,
      taskSpend,
      projectSpend,
      roleBudgetMicros: this.roleBudgetMicros,
      employeeDailyBudgetMicros: this.employeeDailyBudgetMicros,
    });
    if (verdict !== null) this.applyBudgetVerdict(verdict, mostSevereLevel);
  }

  /**
   * §16.1 `budgets.onExceed`: `park` is spec-detailed and this is what S7
   * proves. `ask`/`stop` are a reasonable reading of the setting's own
   * name, not literally detailed in §11.5 — flagged in the session plan
   * for review. `ask` raises a real approval checkpoint (nothing resolves
   * a live one yet — no Director, no chat UI) and parks anyway, matching
   * CLAUDE.md invariant #6: a checkpoint with no live resolver must still
   * fail closed, not leave the employee running unconstrained while
   * "asking". `stop` is more final than park (matches the setting's own
   * name) — a genuinely different action, not park-with-extra-steps.
   */
  private applyBudgetVerdict(verdict: 'park' | 'ask' | 'stop', level: string | null): void {
    // N-16: the Director parks instead. `enforceBudget` has already raised
    // §8.0's approval checkpoint when the Director's full budget is gone.
    if (verdict === 'stop' && !this.mustNotStop()) {
      void this.stop();
      return;
    }
    if (verdict === 'ask') {
      insertCheckpoint(this.db, this.activityLog, {
        project_id: this.currentProjectId,
        task_id: this.currentTaskId,
        employee_id: this.employeeId,
        type: 'approval',
        urgency: 'blocking',
        title: `Budget exceeded (${level ?? 'unknown level'})`,
        context: `This employee's spending crossed a configured budget limit at the "${level ?? 'unknown'}" level and is paused pending a decision.`,
        options: [
          {
            id: 'raise_budget',
            label: 'Raise the budget',
            consequence: 'Increases the limit so this employee can keep working.',
          },
          {
            id: 'leave_parked',
            label: 'Leave parked',
            consequence: 'Work stays paused until you raise the budget or the daily limit resets.',
          },
        ],
        preview: null,
        // Neither option is a safe default to auto-apply, so §9.5 gives
        // this checkpoint no expiry (derived by insertCheckpoint).
        default_action: null,
      });
    }
    // AUDIT #8: end the generation that is already in flight before
    // relabelling the row. Park is resumable (§24.3's tick promotes it
    // back), so this is `interrupt()`, never `stop()` — but leaving the
    // engine running would mean it keeps burning tokens Bureau has
    // already decided not to pay for. Guarded on `caps.interrupt` for the
    // same reason §11.5's breaker guards its own (claude-code structured
    // mode reports false); the `parked` gate in handleEvent is what makes
    // this safe even when the interrupt is unavailable.
    if (this.capabilities?.interrupt) void this.adapter.interrupt();

    // park (and ask, pending its own unresolved checkpoint) both park —
    // §16.1's own default, and the only behaviour S7 requires proof of.
    this.transition('parked', this.currentTaskId, { reason: 'budget_exceeded', level });
  }

  /**
   * §24.3 — the one entry point for both branches of a real, adapter-
   * detected rate-limit response. `per_day` (or a `per_minute` cluster that
   * outlives `engines.rateLimitMaxWaitMinutes`) parks; `per_minute` backs
   * off and retries. Sets `rateLimitedThisCycle` unconditionally — both
   * branches are about to (or already did) transition state on their own
   * terms, so the underlying process's own `finished` a moment later must
   * not ALSO be treated as an independent crash.
   */
  private handleRateLimited(
    classification: 'per_minute' | 'per_day',
    retryAfterMs: number | null,
  ): void {
    this.rateLimitedThisCycle = true;

    if (classification === 'per_day') {
      this.clearRateLimitRetry();
      this.parkForQuotaExhaustion();
      return;
    }

    if (this.rateLimitWaitStartedAt === null) {
      // P-3: a duration, so monotonic. On the wall clock a backward jump made
      // the elapsed time negative and the wait never escalated to exhausted.
      this.rateLimitWaitStartedAt = this.monotonicNow();
      this.rateLimitAttempt = 0;
    }
    const maxWaitMs = getSetting(this.db, 'engines.rateLimitMaxWaitMinutes') * 60_000;
    const elapsedMs = this.monotonicNow() - this.rateLimitWaitStartedAt;
    if (elapsedMs >= maxWaitMs) {
      // §24.3: "Up to engines.rateLimitMaxWaitMinutes, then treat as
      // exhausted." The provider never recovered inside the allowed
      // window — escalate exactly like a real per-day exhaustion.
      this.clearRateLimitRetry();
      this.parkForQuotaExhaustion();
      return;
    }

    // 'waiting' — its OWN visual state (§24.3), never 'thinking', which
    // would show a model working when none is.
    this.transition('waiting', this.currentTaskId, {
      reason: 'rate_limited',
      message: 'waiting on the rate limit',
    });
    this.activityLog.logEvent({
      actor: 'system',
      type: 'employee.rate_limited',
      severity: 'warn',
      project_id: this.currentProjectId,
      task_id: this.currentTaskId,
      employee_id: this.employeeId,
      checkpoint_id: null,
      payload: { attempt: this.rateLimitAttempt, elapsedMs },
    });

    const delayMs = retryAfterMs ?? backoffDelayMs(this.rateLimitAttempt);
    this.rateLimitAttempt += 1;
    this.rateLimitRetryTimer = setTimeout(() => {
      this.rateLimitRetryTimer = null;
      void this.retryAfterRateLimit();
    }, delayMs);
  }

  /** Resends the last thing this class itself sent (see `lastSentText`'s
   * own comment on the real limitation there) once the backoff delay has
   * elapsed. A no-op, honestly, when there is nothing to resend. */
  private async retryAfterRateLimit(): Promise<void> {
    if (this.lastSentText === null || this.lastSentKind === null) return;
    this.transition('working', this.currentTaskId, { reason: 'rate_limit_retry' });
    await this.adapter.send(this.lastSentText, this.lastSentKind);
  }

  private clearRateLimitRetry(): void {
    if (this.rateLimitRetryTimer) clearTimeout(this.rateLimitRetryTimer);
    this.rateLimitRetryTimer = null;
    this.rateLimitWaitStartedAt = null;
    this.rateLimitAttempt = 0;
  }

  /**
   * §24.3's per-day branch: work preserved (nothing deleted or reset),
   * task -> blocked/quota_exhausted, `employee.quota_exhausted` emitted,
   * `resume_at` persisted (§24.3: "a persisted timestamp, not an in-memory
   * timer, so it survives closing the app"), and a real `information`
   * checkpoint with the exact template text — raised directly here, not by
   * "the Director" the spec's own prose names, since no Director agent
   * exists before M11 (the same seam shape M5 used for `integrationRef`).
   */
  private parkForQuotaExhaustion(): void {
    if (this.currentTaskId) {
      setTaskStatus(this.db, this.currentTaskId, 'blocked', 'quota_exhausted');
    }
    const resumeAt = resolveResumeAt(this.pricing, this.adapter.key);
    setEmployeeResumeAt(this.db, this.employeeId, resumeAt.resumeAtIso);
    this.activityLog.logEvent({
      actor: 'system',
      type: 'employee.quota_exhausted',
      severity: 'warn',
      project_id: this.currentProjectId,
      task_id: this.currentTaskId,
      employee_id: this.employeeId,
      checkpoint_id: null,
      payload: { resumeAt: resumeAt.resumeAtIso, resumeAtKnown: resumeAt.known },
    });
    insertCheckpoint(this.db, this.activityLog, {
      project_id: this.currentProjectId,
      task_id: this.currentTaskId,
      employee_id: this.employeeId,
      type: 'information',
      urgency: 'whenever',
      title: `Free quota exhausted for ${this.adapter.key}`,
      context: buildQuotaExhaustedCheckpointText(this.adapter.key, resumeAt),
      // `information` is the one type §9.2 lets omit options: there is
      // nothing to decide, only something to know.
      options: null,
      preview: null,
      default_action: null,
    });
    this.transition('parked', this.currentTaskId, { reason: 'quota_exhausted' });
  }

  // ---- circuit breaker (§11.5, item 10) ----

  /** Releases whatever the raw-stream redaction buffer is currently
   * holding back, to both real sinks — shared by `case 'idle':` and the
   * inactivity timer so the "flush + feed both sinks" logic exists in
   * exactly one place. */
  private flushRedactionStream(): void {
    if (this.redactionInactivityTimer) {
      clearTimeout(this.redactionInactivityTimer);
      this.redactionInactivityTimer = null;
    }
    const flushed = this.redactionStream.flush();
    if (flushed.length > 0) {
      void this.writeTranscript(flushed);
      this.terminal.feed(Buffer.from(flushed, 'utf8'));
    }
  }

  /** Token-velocity trigger — fed from every `recordUsage()` call
   * carrying real usage. */
  private noteTokenUsage(tokens: number): void {
    if (!this.breakerEnabled || tokens <= 0) return;
    this.tokenVelocityWindow.push({ at: Date.now(), tokens });
    const { kept, sum } = pruneAndSumTokens(
      this.tokenVelocityWindow,
      Date.now(),
      TOKEN_VELOCITY_WINDOW_MS,
    );
    this.tokenVelocityWindow = [...kept];
    if (sum >= this.breakerTokensPerMinute)
      this.tripBreaker('token_velocity', { tokensPerMinute: sum });
  }

  /** Error-storm trigger — fed from `case 'tool.completed':` when
   * `event.ok === false`. Tracks a single fixed key per employee (this
   * detector exists only to count "how many tool calls just failed", not
   * to distinguish which ones), reusing `breaker.repeatedToolWindowS` as
   * its window (see the field's own doc comment for why). */
  private noteToolFailure(): void {
    if (!this.breakerEnabled || !this.errorStormDetector) return;
    const tripped = this.errorStormDetector.recordAndCheck(
      this.employeeId,
      'tool.completed',
      'error',
    );
    if (tripped) this.tripBreaker('error_storm', { limit: this.breakerErrorStormLimit });
  }

  /** Wall-clock-overrun trigger — checked from the existing heartbeat
   * tick (already periodic; not a new polling loop). Guarded by
   * `!this.breakerTripped` so this doesn't re-fire (and re-log
   * `cost.breaker_tripped`) on every subsequent tick once already
   * tripped — elapsed time only grows, so once true it stays true until
   * the next real `assign()`. */
  private checkWallClockOverrun(): void {
    if (!this.breakerEnabled || this.wallClockStartedAt === null || this.breakerTripped) return;
    const elapsedMs = Date.now() - this.wallClockStartedAt;
    if (elapsedMs > this.wallClockTimeoutS * 1000) {
      this.tripBreaker('wall_clock_overrun', {
        elapsedMs,
        wallClockTimeoutS: this.wallClockTimeoutS,
      });
    }
  }

  /**
   * §11.5 — the one entry point for all four triggers. `cost.
   * breaker_tripped` is emitted unconditionally (real, regardless of
   * `hardStop`); `breaker.hardStop` skips steering entirely and kills
   * immediately (real, not the default — killing mid-write loses work).
   * Otherwise: steer first, exactly as §11.5 orders it — see
   * `steerBreaker`'s own comment for why the ordering itself is the
   * point, and why a missing `caps.interrupt` skips the message rather
   * than sending it anyway (§11.5's own literal instruction, followed
   * here rather than my own first-draft instinct — see PROGRESS.md).
   */
  private tripBreaker(trigger: BreakerTrigger, detail: Record<string, unknown>): void {
    if (!this.breakerEnabled) return;
    this.activityLog.logEvent({
      actor: 'system',
      type: 'cost.breaker_tripped',
      severity: 'warn',
      project_id: this.currentProjectId,
      task_id: this.currentTaskId,
      employee_id: this.employeeId,
      checkpoint_id: null,
      payload: { trigger, detail },
    });
    if (this.breakerHardStop) {
      this.stopForBreaker(trigger, detail);
      return;
    }
    if (this.breakerTripped) return; // already mid-steer — don't restart the clock on a repeat trigger
    this.breakerTripped = true;
    void this.steerBreaker(trigger, detail);
  }

  /**
   * §11.5's literal ordering: interrupt() first (ends the current
   * generation), THEN send the corrective message — §7.4's own
   * turn-boundary queue does the "wait for idle" work for free (`send()`
   * queues while `turnState !== 'idle'`, flushes on the real next `idle`
   * event; no separate wait mechanism needed). A looping agent is by
   * definition not idle, so the interrupt is what CREATES the idle the
   * message can land at — inject it without interrupting first and it
   * either never lands or lands arbitrarily late (CLAUDE.md: "do not
   * inject a message into an agent mid-generation — wait for idle").
   *
   * If `caps.interrupt` is false (claude-code, structured mode — today's
   * only real adapter, per M3's own confirmed research): §11.5's own
   * text says "SKIP TO STEP 3", literally, not "send anyway and hope it
   * lands well" — my first draft did the latter and was corrected in
   * review (see PROGRESS.md). There is no interrupt-created idle to land
   * the message at in this case, and queuing it anyway risks it landing
   * after the agent has already stopped looping on its own, telling it
   * it's still doing something it may no longer be doing.
   */
  private async steerBreaker(
    trigger: BreakerTrigger,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (this.capabilities?.interrupt) {
      await this.adapter.interrupt();
      await this.adapter.send(STEER_MESSAGE, 'steer');
    }
    this.breakerConstrained = true;
    // The Director case (§8.0's own reasoning, transferred): a STOPPED
    // Director leaves the user with nobody to talk to, and the blocker
    // checkpoint stopForBreaker would raise has nobody left to answer
    // it — the same deadlock the budget reserve exists to prevent,
    // reached by a different route. The Director may be constrained
    // (still real protection — every subsequent tool call now requires
    // confirmation) but is never stopped by the breaker.
    if (this.mustNotStop()) return;
    this.scheduleBreakerEscalation(trigger, detail);
  }

  private scheduleBreakerEscalation(
    trigger: BreakerTrigger,
    detail: Record<string, unknown>,
  ): void {
    this.breakerEscalationTimer = setTimeout(() => {
      this.breakerEscalationTimer = null;
      if (this.breakerTriggerStillHolds(trigger)) {
        this.stopForBreaker(trigger, detail);
      } else {
        // Genuine improvement — the trigger's own condition cleared
        // before the timeout. breakerConstrained deliberately stays true
        // (§11.5's plan-stage decision: once flagged, this employee keeps
        // requiring confirmation for the rest of this task assignment,
        // not just until the timer would have fired) — only breakerTripped
        // resets, so a LATER fresh trigger can go through the full
        // sequence again rather than being silently swallowed by the
        // "already mid-steer" guard above.
        this.breakerTripped = false;
      }
    }, this.breakerSteerTimeoutS * 1000);
  }

  /**
   * "No improvement" (§11.5), checked as accurately as each trigger
   * allows without fabricating evidence: `wall_clock_overrun` is
   * monotonic (elapsed time never decreases, so it always still holds —
   * it can never genuinely improve). `token_velocity` and `error_storm`
   * are both Supervisor-owned sliding windows — `peek()` (not
   * `recordAndCheck()`) asks "does this currently hold" with no side
   * effect. `repeated_tool_calls` is the one real gap: that detector
   * lives in the POLICY layer (`policyEvaluator.ts`'s own instance), not
   * reachable from here — Supervisor only ever learns about it via the
   * one-way `noteLoopDetected()` call, with no way to ask it "still
   * looping?" without fabricating a call. Defaults to "still holds"
   * (escalates) in that one case — the safe direction (CLAUDE.md #6),
   * not a guess either way.
   */
  private breakerTriggerStillHolds(trigger: BreakerTrigger): boolean {
    switch (trigger) {
      case 'wall_clock_overrun':
        return true;
      case 'token_velocity': {
        const { sum } = pruneAndSumTokens(
          this.tokenVelocityWindow,
          Date.now(),
          TOKEN_VELOCITY_WINDOW_MS,
        );
        return sum >= this.breakerTokensPerMinute;
      }
      case 'error_storm':
        return (
          (this.errorStormDetector?.peek(this.employeeId, 'tool.completed', 'error') ?? 0) >=
          this.breakerErrorStormLimit
        );
      case 'repeated_tool_calls':
        return true;
      default: {
        const exhaustive: never = trigger;
        return exhaustive;
      }
    }
  }

  /**
   * N-16: the one guard every Supervisor-initiated stop path consults
   * (`applyBudgetVerdict`'s `stop`, `stopForBreaker`, `steerBreaker`'s
   * escalation). §8.0: a stopped Director leaves the user with nobody to talk
   * to and nobody to answer the checkpoint the stop would raise. Explicit
   * user and shutdown stops (`stop()` itself) are not stop *decisions* and do
   * not consult it.
   */
  private mustNotStop(): boolean {
    return this.isDirector;
  }

  /**
   * §11.5 step 4 — real, not the default (`breaker.hardStop` is the
   * immediate-kill path; this is what a normal steer-first trip
   * escalates to). `employee.stopped` (§5.2) is emitted directly here,
   * separate from `stop()`'s own `employee.stopping`→`employee.off`
   * transitions — this event carries the WHY a plain status transition
   * can't ("the breaker gave up on this employee"), which is a real,
   * distinct fact worth its own record.
   */
  private stopForBreaker(trigger: BreakerTrigger, detail: Record<string, unknown>): void {
    if (this.breakerEscalationTimer) {
      clearTimeout(this.breakerEscalationTimer);
      this.breakerEscalationTimer = null;
    }
    // N-16: `breaker.hardStop` reaches here without steering. The Director
    // is constrained instead, exactly as the steer path leaves it.
    if (this.mustNotStop()) {
      this.breakerConstrained = true;
      return;
    }
    this.activityLog.logEvent({
      actor: 'system',
      type: 'employee.stopped',
      severity: 'warn',
      project_id: this.currentProjectId,
      task_id: this.currentTaskId,
      employee_id: this.employeeId,
      checkpoint_id: null,
      payload: { reason: 'breaker_tripped', trigger, detail },
    });
    const checkpoint = insertCheckpoint(this.db, this.activityLog, {
      project_id: this.currentProjectId,
      task_id: this.currentTaskId,
      employee_id: this.employeeId,
      ...buildBreakerBlockerCheckpointInput(trigger, detail),
    });
    // M8: the task is blocked THROUGH the checkpoint, not beside it. The
    // bare setTaskStatus this replaces emitted no `task.blocked` event at
    // all — a real state change going unrecorded, against invariant #3 —
    // and wrote a prose reason nothing could match on. `status_reason` is
    // now the key `answerCheckpoint` uses to decide it may unblock; the
    // prose survives in the event payload.
    if (this.currentTaskId) {
      blockTaskForCheckpoint(this.db, this.activityLog, {
        taskId: this.currentTaskId,
        checkpointId: checkpoint.id,
        detail: `breaker_tripped: ${trigger}`,
        employeeId: this.employeeId,
      });
    }
    void this.stop();
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
  private handleFinished(reason: string, summary: string | null): void {
    // §24.3: a rate-limited turn's own process exiting non-zero right after
    // (structured mode's child.on('exit') firing with reason:'error') is
    // the EXPECTED shape, already handled (waiting/parked, above) — not a
    // second, independent crash. Consumed exactly once per cycle; a
    // genuine 'completed' still proceeds normally either way (harmless if
    // it somehow follows a rate-limited cycle instead of 'error').
    const wasRateLimited = this.rateLimitedThisCycle;
    this.rateLimitedThisCycle = false;
    if (wasRateLimited && reason !== 'completed') {
      return;
    }
    if (reason === 'completed') {
      this.consecutiveFailures = 0;
      setEmployeeConsecutiveFailures(this.db, this.employeeId, 0);

      const gotReport =
        this.taskDoneReportedForTaskId !== null &&
        this.taskDoneReportedForTaskId === this.currentTaskId;
      this.taskDoneReportedForTaskId = null;

      if (gotReport) {
        this.transition('idle', this.currentTaskId, { reason: 'task_reported' });
      } else {
        this.transition('blocked', this.currentTaskId, { reason: 'ended_without_report' });
      }
    } else {
      this.handleFailure(`adapter finished with reason=${reason}`, summary);
    }
  }

  /** §7.11: exit≠0 or heartbeat timeout -> failed, backoff, retry to max_attempts. */
  private handleFailure(message: string, detail: string | null = null): void {
    // P-2 / chaos #9: a spawn that fails because the program is gone is the
    // one failure a person can act on, so it is said in their words. The raw
    // text stays in `detail` for diagnosis. The probe cache is told, so the
    // next probe looks again rather than repeating "installed" for a minute.
    const engineGone = detail !== null && detail.includes('ENOENT');
    if (engineGone) this.probeCache.forget(this.adapter);
    const userMessage = engineGone
      ? `${this.adapter.key} could not be started: its program is no longer on this computer (it may have been uninstalled or moved). Reinstall it, then resume this employee.`
      : message;
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
      payload: {
        message: userMessage,
        detail,
        consecutiveFailures: this.consecutiveFailures,
        maxAttempts: this.maxAttempts,
      },
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
    // §11.5, item 10 — the wall-clock-overrun trigger, piggybacked on
    // this already-periodic tick rather than a new polling loop.
    // Orthogonal to the hang detection below: this fires on a task that
    // has run too long overall, whether or not the adapter is currently
    // silent.
    this.checkWallClockOverrun();
    // S-3: an idle employee with nothing to do must not hold a process
    // (§22.3). Checked before hang detection: a quiet idle employee is not hung.
    if (this.shouldIdleStop()) {
      void this.stop(undefined, 'idle');
      return;
    }
    const timeoutMs =
      this.mode === 'pty'
        ? this.heartbeatConfig.ptyTimeoutMs
        : this.heartbeatConfig.structuredTimeoutMs;
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

  /**
   * S-3 / §7's supervisor limits: "idle-stop after
   * `orchestrator.idleStopMinutes` (→ `off`, still assignable)". Only an
   * employee with no task: one idle between turns of a task (waiting on an
   * answer, say) still owns that task. Never the Director (§8.0 keeps its
   * session warm; `mustNotStop`). Measured on the monotonic clock (P-3).
   */
  private shouldIdleStop(): boolean {
    if (this.idleStopMinutes <= 0) return false;
    if (this.state !== 'idle' || this.idleSinceMs === null) return false;
    if (this.currentTaskId !== null || this.mustNotStop()) return false;
    return this.monotonicNow() - this.idleSinceMs >= this.idleStopMinutes * 60_000;
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

  // ---- user control (§14.5, §17.1's employees.* methods) ----

  /**
   * The user pausing an employee. Interrupts the current generation where
   * the engine supports it, then parks — reusing the same `parked` state
   * a budget stop uses, and therefore the same gate session 1's audit fix
   * added to `handleEvent` (a parked employee refuses to resume on a
   * `turn.started`).
   *
   * **Deliberately does NOT refuse the Director**, unlike `fireEmployee`.
   * The rule is that any operation which could remove the user's only way
   * back must refuse; a pause is not one, because `resume()` needs no
   * model call — the same escape hatch §8.0 describes for an exhausted
   * budget. Firing has no equivalent.
   *
   * **Corrected in M9 session 2.** The paragraph above was true of this
   * class and false of the product for four milestones: it says a pause is
   * undoable *because `resume()` exists*, and nothing called `resume()`.
   * No renderer surface called `employees.pause` or `resumeEmployee` at
   * all, and after a restart there was no way to reach either — a manual
   * pause leaves `resume_at` null, which is the one thing
   * `promoteResumableParkedEmployees` needs. §14.2's `/pause` made pausing
   * reachable, so the undo was made genuinely reachable in the same
   * commit: see `employees.resumeEmployee`, which now serves the
   * no-live-process case too, and the Resume control above the composer.
   * Standing rule 2 is what this was — a guard whose own comment cited a
   * rule as satisfied, on the strength of a function no production path
   * called.
   */
  async pause(): Promise<void> {
    if (this.state === 'parked' || this.state === 'off') return;
    // §11.5's own ordering: interrupt first where possible, so the park
    // takes effect now rather than after the current turn finishes.
    if (this.capabilities?.interrupt) await this.adapter.interrupt();
    this.transition('parked', this.currentTaskId, { reason: 'user_paused' });
  }

  /** Clears a user pause. Returns false when the employee was not paused,
   * so a caller can say "they were not paused" rather than pretending. */
  resume(): boolean {
    if (this.state !== 'parked') return false;
    this.transition('idle', this.currentTaskId, { reason: 'user_resumed' });
    return true;
  }

  /**
   * §14.5 — "stop what you are doing now", without changing employment or
   * parking anyone. The engine returns to `idle` through its own event
   * stream, so no state is forced here; forcing one would race the
   * adapter's own idle.
   *
   * Returns false when the engine cannot be interrupted (claude-code's
   * real default in structured mode — §7.6), so the caller can say so
   * instead of reporting a success that did not happen.
   */
  async interruptNow(): Promise<boolean> {
    if (this.capabilities?.interrupt !== true) return false;
    await this.adapter.interrupt();
    return true;
  }

  // ---- lifecycle ----

  async stop(graceMs?: number, reason?: 'idle'): Promise<void> {
    this.stopping = true;
    this.stopHeartbeatMonitor();
    // A pending rate-limit retry must never fire against a torn-down
    // adapter/employee — the same discipline stopHeartbeatMonitor() already
    // applies to its own timer.
    this.clearRateLimitRetry();
    // Same discipline for the breaker's own escalation timer and the
    // redaction stream's inactivity timer — neither may fire after this
    // employee is gone.
    if (this.breakerEscalationTimer) {
      clearTimeout(this.breakerEscalationTimer);
      this.breakerEscalationTimer = null;
    }
    if (this.redactionInactivityTimer) {
      clearTimeout(this.redactionInactivityTimer);
      this.redactionInactivityTimer = null;
    }
    this.transition('stopping', this.currentTaskId, reason === undefined ? null : { reason });
    await this.adapter.stop(graceMs);
    this.terminal.dispose();
    // §7.10: a token "is revoked when the process exits" — the adapter's
    // process is what just stopped, above, so this is that exact moment.
    // Optional deps (see SupervisorOptions' own comment): every test that
    // predates the control channel keeps working unchanged.
    this.tokenRegistry?.revoke(this.employeeId);
    this.supervisorRegistry?.unregister(this.employeeId);
    // §11.4: "revokeForEmployee() must be called on every stop path" —
    // this is the clean-stop path (the other real one, reconcile.ts's
    // orphan sweep, calls it independently — see that file's own
    // comment). Optional (no `broker` before assign() has run), same
    // shape as tokenRegistry/supervisorRegistry above.
    void this.broker?.revokeForEmployee(this.employeeId);
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
  /**
   * M11 row S1-10: whether a queued send may be delivered now. False from
   * the moment this employee is parked, paused, stopping or stopped —
   * every state in which a new turn is money Bureau has decided not to
   * spend.
   */
  /** The session id already written to this employee's row (M11 row S1-11). */
  private lastPersistedSessionId: string | null = null;

  /** Set only while `confirmHookLiveness` is waiting for the report. */
  private hookReportWaiter: ((sessionId: string) => void) | null = null;

  /**
   * M11 hook liveness: the `SessionStart` hook reached the control channel
   * with this employee's token (`/v1/hook/session-start`). Only a start that
   * is waiting cares; every later turn's report arrives here as a no-op.
   */
  noteHookSessionStarted(sessionId: string): void {
    this.hookReportWaiter?.(sessionId);
  }

  /**
   * §7.6: registering a hook is not proof the CLI runs it. Under `--bare` it
   * does not, and a `bureau_` tool call then changes Bureau's state with no
   * policy check. So an engine whose gate is a hook launches once, with no
   * model call, and its `SessionStart` hook must report back with this
   * employee's token before the employee may start. No report → refused
   * (invariant #6). Returns the session id the hook reported.
   */
  private async confirmHookLiveness(ctx: EmployeeContext): Promise<string> {
    const refusal = new EngineHookNotRunningError(
      `Bureau didn't start this employee because it couldn't confirm that ${this.adapter.key} ` +
        "runs Bureau's safety check, which reviews every action before it happens. Bureau won't " +
        'run an employee whose actions it cannot check. This can follow an engine update; ' +
        'updating Bureau or reinstalling the engine usually fixes it.',
    );
    if (!this.adapter.runHookHandshake) throw refusal;
    let reported: (sessionId: string) => void = () => {};
    const report = new Promise<string>((resolve) => {
      reported = resolve;
    });
    this.hookReportWaiter = (sessionId) => reported(sessionId);
    let graceTimer: NodeJS.Timeout | undefined;
    try {
      await this.adapter.runHookHandshake(ctx);
      // The hook answers before the CLI exits, so the report is normally
      // here already; the grace only absorbs the loopback round trip.
      const sessionId = await Promise.race([
        report,
        new Promise<null>((resolve) => {
          graceTimer = setTimeout(() => resolve(null), HOOK_REPORT_GRACE_MS);
        }),
      ]);
      if (sessionId === null) throw refusal;
      return sessionId;
    } finally {
      clearTimeout(graceTimer);
      this.hookReportWaiter = null;
    }
  }

  private mayDeliverNow(): boolean {
    return (
      this.state !== 'parked' &&
      this.state !== 'stopping' &&
      this.state !== 'off' &&
      this.state !== 'failed'
    );
  }

  private transition(
    next: SupervisorState,
    taskId: string | null,
    payload: Record<string, unknown> | null = null,
  ): void {
    if (this.state === next) return;
    this.state = next;
    // M11 row S1-10: a park drops what was queued, rather than leaving it
    // for a later idle to flush into a billed turn. Done here so every
    // park does it — budget, quota, breaker and a user pause alike — and
    // the count is on the event that records the park.
    if (next === 'parked') {
      const droppedSends = this.adapter.dropQueuedSends?.() ?? 0;
      payload = { ...(payload ?? {}), droppedSends };
    }
    this.idleSinceMs = next === 'idle' ? this.monotonicNow() : null;
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

/**
 * The text an outbox message actually becomes when it reaches an agent.
 *
 * A bare body would arrive indistinguishable from the user speaking, which
 * matters for a `question` from a peer far more than for a `status`: the
 * recipient needs to know who is waiting on it and what kind of thing it
 * is. Kept here, next to the one method that sends it, rather than in the
 * router — the router decides *whether* and *when*; the adapter-facing
 * shape of a turn belongs to the class that owns turns.
 */
function renderOutboxMessage(message: OutboxMessage): string {
  const lines = [`Message from ${message.from_addr} (${message.kind}):`];
  if (message.subject !== null && message.subject.length > 0) lines.push(message.subject);
  // `bureau_send_message` requires a non-empty body and `answerCheckpoint`
  // always composes one, so an empty body means a producer that has not
  // been written yet. Sending the header alone is more useful to the
  // recipient than sending nothing, and more honest than inventing text.
  if (message.body !== null && message.body.length > 0) lines.push('', message.body);
  return lines.join('\n');
}
