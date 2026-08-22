import type { EngineMode } from '../models/enums';
import type { AgentEvent, SendKind } from './events';
import type {
  EmployeeContext,
  EngineCapabilities,
  LaunchSpec,
  PolicyVerdict,
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

  /** Installed? Authenticated? Which version? MUST NOT throw. MUST finish < 5s. */
  probe(): Promise<ProbeResult>;

  /** What this engine can actually do at this version. Never aspirational. */
  capabilities(probe: ProbeResult): EngineCapabilities;

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
