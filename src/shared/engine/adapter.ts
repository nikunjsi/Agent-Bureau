import type { EngineMode } from '../models/enums';
import type { AgentEvent, SendKind } from './events';
import type {
  EmployeeContext,
  EngineCapabilities,
  LaunchSpec,
  PolicyVerdict,
  ProbeOptions,
  ProbeResult,
} from './types';

/**
 * §7.1 — the contract. Everything above the adapter consumes one normalised
 * event stream; an adapter's whole job is to turn a specific agent CLI or
 * SDK into that stream and translate Bureau's decisions back. `FakeAdapter`
 * (§7.8) implements this in full with zero network and zero spend — it is
 * what the rest of the Core is tested against, built before any real
 * adapter.
 */
export interface EngineAdapter {
  readonly key: string; // 'claude-code'
  readonly supportedModes: ReadonlySet<EngineMode>;

  /**
   * Installed? Authenticated? Which version? **MUST NOT throw**, and MUST
   * finish within `options.budgetMs` — capped at, and defaulting to,
   * `PROBE_LIVENESS_CEILING_MS` (§7.8).
   *
   * The budget comes from the caller because the two things this deadline
   * was asked to be want different numbers, and only the call site knows
   * which one it needs: a settings toggle with a person waiting on it asks
   * for `PROBE_RESPONSIVENESS_BUDGET_MS` and handles an `indeterminate`
   * answer; `Supervisor.assign()` has nobody watching a spinner and takes
   * the ceiling. The cap is not negotiable from the call site — "never
   * hangs" is the adapter's own guarantee, not the caller's choice.
   *
   * An adapter that runs out of budget MUST return `determination:
   * 'indeterminate'` with the fail-closed field values, and MUST NOT report
   * `determination: 'determined'` for an answer it did not actually reach.
   * "It is not installed" and "I could not find out" are different facts
   * and lead a user to different actions.
   */
  probe(options: ProbeOptions): Promise<ProbeResult>;

  /**
   * What this engine can actually do at this version. Never aspirational.
   * `mode` unset = the engine-level answer, before a mode is chosen — what
   * §7.3's auto-selection asks. A resolved `mode` asks the honest, per-mode
   * question instead (M3 session 3 correction): capabilities genuinely
   * differ by mode (PTY mode cannot report usage; it has no session id to
   * resume without content parsing), and a caller holding a snapshot taken
   * before `start()` must never silently keep treating it as still current
   * once a mode is actually running. The method takes the mode as an
   * explicit parameter rather than reading adapter-internal state so the
   * caller's question is always visible at the call site, not implied by
   * when the call happens to run.
   */
  capabilities(probe: ProbeResult, mode?: EngineMode): EngineCapabilities;

  /** Role + task + context → argv, env, cwd. MUST NOT read secrets directly (§11.4 — see SecretBroker). */
  buildLaunchSpec(ctx: EmployeeContext): Promise<LaunchSpec>;

  start(ctx: EmployeeContext): Promise<void>;

  /** Deliver a prompt or injected message. MUST respect turn boundaries (§7.4). */
  send(text: string, kind: SendKind): Promise<void>;

  /** Normalised stream. MUST terminate when the process exits. */
  events(): AsyncIterable<AgentEvent>;

  /** Answer a pending permission request. */
  applyVerdict(callId: string, verdict: PolicyVerdict): Promise<void>;

  /** Stop the current turn without killing the session, if supported. */
  interrupt(): Promise<void>;

  /**
   * M11 row S1-10. The Supervisor's answer to "may a queued send go out
   * now?", consulted before the adapter flushes its turn-boundary queue. A
   * park or a pause closes it, so a child's own exit cannot launch a fresh,
   * billed turn the Supervisor has already decided not to run.
   *
   * Optional on the interface, implemented by all three adapters: an
   * adapter with no queue of its own has nothing to gate.
   */
  setDeliveryGate?(gate: (() => boolean) | null): void;

  /** Discards the queued sends, returning how many were dropped. */
  dropQueuedSends?(): number;

  /**
   * M11 row S1-18: forget the engine session, so the next turn starts a
   * fresh one instead of resuming. Compaction's second half: the summary is
   * carried by the new session's context, not by the old transcript.
   */
  resetSession?(): void;

  /**
   * M11 hook liveness (§7.6). An engine whose policy gate is a hook
   * (`capabilities.hookInterception`) launches once, with no model call, so
   * that hook can report to the control channel. Resolves once that launch
   * is over. The Supervisor refuses to start an employee whose report never
   * arrived — and refuses one whose adapter claims a hook but has no way to
   * prove it runs.
   */
  runHookHandshake?(ctx: EmployeeContext): Promise<void>;

  stop(graceMs?: number): Promise<void>;

  /** Resume a prior session; false if unsupported or gone. MUST NOT hang. */
  resume(sessionId: string, ctx: EmployeeContext): Promise<boolean>;

  /**
   * §7.11 (M3 session 2 addition — the supervisor's heartbeat needs this
   * and nothing else already provides it). Epoch ms of the most recent
   * *raw* activity — any byte on the stream in PTY mode, any parsed
   * message in structured mode — deliberately independent of the
   * semantic `AgentEvent` stream: a line that doesn't map to any
   * `AgentEvent` (an unrecognised stream-json type, for one real example)
   * still proves the process is alive, and heartbeat liveness cares about
   * that, not about whether the mapper recognised the shape.
   */
  lastActivityAt(): number;
}
