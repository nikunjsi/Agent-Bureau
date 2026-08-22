import fs from 'node:fs';
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

type TurnState = 'idle' | 'generating' | 'toolRunning' | 'awaitingApproval';

export interface SentSendRecord {
  text: string;
  kind: SendKind;
  /** 'immediate' if turnState was idle when send() was called; 'flushed-on-idle' if it had to wait (§7.4). */
  delivery: 'immediate' | 'flushed-on-idle';
}

export interface FakeAdapterScript {
  /** Replayed via events(), in order, one per pull of the async iterable — no adapter ever advances on its own. */
  events?: AgentEvent[];
  /**
   * callId → filesystem path to touch iff a later `applyVerdict(callId, {effect:'allow'})`
   * is called for that callId. A 'deny' verdict never touches it, and no
   * verdict at all never touches it — this is §7.8 test 4's actual proof
   * point ("the command provably did not execute" via a filesystem
   * sentinel, not "the log says denied"), and it is real, not simulated:
   * FakeAdapter genuinely writes the file, so a test asserting its absence
   * is asserting a real fact, not trusting FakeAdapter's own bookkeeping.
   */
  toolSentinels?: Record<string, string>;
  /** What resume(sessionId) returns; a sessionId not present here returns false — never hangs, matches §7.1's contract. */
  resumeResults?: Record<string, boolean>;
  probeResult?: Partial<ProbeResult>;
  capabilities?: Partial<EngineCapabilities>;
}

/**
 * §7.8: "A FakeAdapter implementing the full contract with scripted event
 * sequences MUST exist, so the entire Core can be tested with no engine
 * installed and zero model spend." Built before any real adapter —
 * everything downstream tests against this, not against `claude-code`.
 *
 * Turn-boundary discipline (§7.4) is real, not stubbed: `send()` genuinely
 * queues while `turnState !== 'idle'` and only delivers on the next `idle`
 * event actually pulled through `events()` — because the real thing this
 * class exists to let the rest of the Core test against is exactly that
 * discipline, not just event playback.
 *
 * A known, deliberate limitation (M3->M4 boundary check): the SCRIPT
 * itself replays unconditionally — "no adapter ever advances on its own"
 * describes calling `events()`, not whether `send()` was ever called
 * first. A real adapter's `events()` yields nothing until `send()`
 * triggers an actual spawn; this one does not enforce that, on purpose,
 * so a test can drive an arbitrary event sequence at Supervisor without
 * also having to correctly orchestrate turn-boundary timing every time —
 * most of supervisor.test.ts is exactly that kind of test. The real cost:
 * this fake would have let `Supervisor.assign()` never calling `send()`
 * with the task pass silently, and did, for every existing test, until
 * `tests/integration/engine/endToEndChain.test.ts` was written
 * specifically to catch it — one leg against this adapter (checking
 * `sentMessages`), one against a real adapter (`GenericPtyAdapter`) so no
 * fake's leniency can hide this class of bug again. Considered making
 * this adapter itself require a prior `send()` before advancing;
 * rejected — see that decision recorded in PROGRESS.md rather than
 * re-litigated here.
 */
export class FakeAdapter implements EngineAdapter {
  readonly key = 'fake';
  readonly supportedModes: ReadonlySet<EngineMode> = new Set(['structured']);

  private readonly script: FakeAdapterScript;
  private readonly scriptedEvents: AgentEvent[];
  private readonly appliedVerdicts = new Map<string, PolicyVerdict>();
  private readonly sendLog: SentSendRecord[] = [];
  private pendingSends: Array<{ text: string; kind: SendKind }> = [];
  private turnState: TurnState = 'idle';
  private interruptCount = 0;
  private stopped = false;
  private stopGraceMs: number | undefined;
  // FakeAdapter has no separate raw channel — every scripted event counts
  // as activity, which is the closest honest analogue for a fake.
  private lastActivityAtMs = Date.now();

  constructor(script: FakeAdapterScript = {}) {
    this.script = script;
    this.scriptedEvents = script.events ?? [];
  }

  async probe(): Promise<ProbeResult> {
    return {
      installed: true,
      authenticated: true,
      version: '0.0.0-fake',
      binaryPath: null,
      error: null,
      metered: false, // fake — §7.8: zero model spend
      ...this.script.probeResult,
    };
  }

  // `mode` accepted for interface compliance (M3 session 3 correction 1)
  // but ignored: FakeAdapter is a single fully-scripted double with no real
  // per-mode behaviour to report honestly, so claiming mode-independence
  // for it is the accurate answer, not a shortcut. A test that specifically
  // wants to exercise a mode-aware consumer overrides via `script.capabilities`.
  capabilities(_probe: ProbeResult, _mode?: EngineMode): EngineCapabilities {
    return {
      structuredEvents: true,
      permissionCallback: true,
      hookInterception: false,
      sessionResume: true,
      interrupt: true,
      usageReporting: true,
      mcpServers: false,
      modelSelection: false,
      maxContextTokens: null,
      promptCaching: false,
      ...this.script.capabilities,
    };
  }

  async buildLaunchSpec(ctx: EmployeeContext): Promise<LaunchSpec> {
    // No real secrets, no real binary — buildLaunchSpec's own "MUST NOT
    // read secrets directly" rule is trivially honoured because this
    // adapter never touches ctx.broker at all.
    return {
      command: 'fake-adapter',
      args: [],
      cwd: ctx.worktreePath,
      env: {},
      configFiles: [],
    };
  }

  async start(_ctx: EmployeeContext): Promise<void> {
    this.turnState = 'idle';
  }

  async send(text: string, kind: SendKind): Promise<void> {
    if (this.turnState !== 'idle') {
      this.pendingSends.push({ text, kind });
      return;
    }
    this.sendLog.push({ text, kind, delivery: 'immediate' });
  }

  async *events(): AsyncIterable<AgentEvent> {
    for (const event of this.scriptedEvents) {
      this.lastActivityAtMs = Date.now();
      this.applyStateTransition(event);
      // Flush BEFORE yielding: a generator body only resumes past its
      // `yield` on the consumer's *next* pull, so anything scheduled after
      // `yield event` here would only take effect one full cycle late —
      // by the time a consumer merely *observes* the idle event, the
      // queue must already be flushed, matching §7.4's "flushing on the
      // next idle event" literally, not "flushing after the one after".
      if (event.t === 'idle') this.flushPendingSends();
      yield event;
    }
  }

  async applyVerdict(callId: string, verdict: PolicyVerdict): Promise<void> {
    this.appliedVerdicts.set(callId, verdict);
    if (verdict.effect === 'allow') {
      const sentinelPath = this.script.toolSentinels?.[callId];
      if (sentinelPath) fs.writeFileSync(sentinelPath, '');
    }
    // A deny (or an allow with no sentinel configured) deliberately does
    // nothing further — no fabricated side effect either way.
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
    this.turnState = 'idle';
  }

  async stop(graceMs?: number): Promise<void> {
    this.stopped = true;
    this.stopGraceMs = graceMs;
  }

  async resume(sessionId: string, _ctx: EmployeeContext): Promise<boolean> {
    return this.script.resumeResults?.[sessionId] ?? false;
  }

  lastActivityAt(): number {
    return this.lastActivityAtMs;
  }

  private applyStateTransition(event: AgentEvent): void {
    switch (event.t) {
      case 'turn.started':
      case 'text.delta':
      case 'thinking.delta':
        this.turnState = 'generating';
        break;
      case 'tool.requested':
        this.turnState = 'awaitingApproval';
        break;
      case 'tool.completed':
        this.turnState = 'generating';
        break;
      case 'idle':
        this.turnState = 'idle';
        break;
      default:
        break;
    }
  }

  private flushPendingSends(): void {
    for (const { text, kind } of this.pendingSends) {
      this.sendLog.push({ text, kind, delivery: 'flushed-on-idle' });
    }
    this.pendingSends = [];
  }

  // Test-inspection surface — not part of EngineAdapter, only ever used by
  // tests asserting on what this fake actually did.
  get sentMessages(): readonly SentSendRecord[] {
    return this.sendLog;
  }

  get interruptCallCount(): number {
    return this.interruptCount;
  }

  get wasStopped(): boolean {
    return this.stopped;
  }

  get lastStopGraceMs(): number | undefined {
    return this.stopGraceMs;
  }

  verdictFor(callId: string): PolicyVerdict | undefined {
    return this.appliedVerdicts.get(callId);
  }
}
