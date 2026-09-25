/**
 * §26.1: what wakes the Director (M11 row S1-15). **One queue decides every
 * Director turn**: a producer offers a trigger, and this decides when, and
 * together with what, it becomes a turn.
 *
 * The rules, one table (`DIRECTOR_TRIGGER_RULES`):
 * - **Nothing is delivered mid-generation.** A turn goes out only while the
 *   Director is idle (CLAUDE.md: never inject a message mid-generation).
 * - **A user message is immediate and never coalesced with anything else**,
 *   but several user messages waiting at once (typically: sent while the
 *   Director was mid-turn) become one turn (§M11 item 6).
 * - **An answered blocking checkpoint and a restart report go alone.**
 * - **Triggers that coalesce do so within `director.coalesceWindowSeconds`**,
 *   counted from the oldest one waiting, and become one turn.
 * - When several could go, priority decides: immediate, high, medium, low.
 * - **A turn belongs to one conversation** (M11 S2-1a). Triggers from two
 *   conversations never share a turn: the oldest waiting at the winning
 *   priority decides the conversation, and only its triggers go.
 *
 * **Never a bare timer.** The only timers here are the coalesce window,
 * armed because a trigger is waiting, and the heartbeat, which offers a
 * trigger only when events have happened since its last one.
 *
 * Pure and synchronous apart from `deliverTurn`: the clock, the idle check
 * and the delivery are injected, so every rule is testable on a fake clock.
 */
export type DirectorTriggerKind =
  | 'user_message'
  | 'checkpoint_answered'
  | 'ask_director'
  | 'employee_message'
  | 'restart'
  | 'heartbeat';

export type TriggerPriority = 'immediate' | 'high' | 'medium' | 'low';

export const DIRECTOR_TRIGGER_RULES: Readonly<
  Record<DirectorTriggerKind, { readonly priority: TriggerPriority; readonly coalesces: boolean }>
> = {
  user_message: { priority: 'immediate', coalesces: false },
  checkpoint_answered: { priority: 'immediate', coalesces: false },
  ask_director: { priority: 'high', coalesces: true },
  employee_message: { priority: 'high', coalesces: true },
  restart: { priority: 'medium', coalesces: false },
  heartbeat: { priority: 'low', coalesces: true },
};

const PRIORITY_ORDER: readonly TriggerPriority[] = ['immediate', 'high', 'medium', 'low'];

export interface DirectorTrigger {
  readonly kind: DirectorTriggerKind;
  /** Offering the same key twice is one trigger: the router re-lists a
   *  message on every tick until it is marked delivered. */
  readonly key: string;
  /** What the Director's turn is told about this trigger. */
  readonly text: string;
  /** Set when the trigger is an outbox message, so the turn can mark it. */
  readonly messageId?: string;
  /** A user message's own words, for intent classification (M11 S1-16). */
  readonly userText?: string;
  /**
   * The conversation this trigger belongs to (M11 S2-1a). `null` is the
   * company conversation, resolved when the turn goes: the restart report
   * and the heartbeat are company business, and there may be no
   * conversation yet when they are offered. Required, so no producer can
   * leave it to "wherever the Director happens to be".
   */
  readonly conversationId: string | null;
}

export interface DirectorTurn {
  readonly triggers: readonly DirectorTrigger[];
  readonly text: string;
  /** Every trigger's conversation: one turn, one conversation. */
  readonly conversationId: string | null;
}

export interface TriggerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTriggerClock: TriggerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DirectorTriggerQueueDeps {
  readonly clock: TriggerClock;
  /** Read per decision, so a changed setting applies to the next window. */
  readonly coalesceWindowMs: () => number;
  readonly isDirectorIdle: () => boolean;
  /** Sends one turn. The queue will not send another while this is pending. */
  readonly deliverTurn: (turn: DirectorTurn) => Promise<void | 'deferred'>;
}

interface Waiting {
  readonly trigger: DirectorTrigger;
  readonly offeredAtMs: number;
}

function sameConversation(candidates: Waiting[], first: Waiting): Waiting[] {
  return candidates.filter((w) => w.trigger.conversationId === first.trigger.conversationId);
}

/** Keys remembered after delivery, so a re-listed message is not a second
 *  trigger. Bounded: the oldest are forgotten first. */
const DELIVERED_KEYS_KEPT = 1_000;

export class DirectorTriggerQueue {
  private waiting: Waiting[] = [];
  private readonly deliveredKeys = new Set<string>();
  private delivering = false;
  private windowTimer: unknown = null;
  private stopped = false;

  constructor(private readonly deps: DirectorTriggerQueueDeps) {}

  /** Returns false when this key is already waiting or was delivered. */
  offer(trigger: DirectorTrigger): boolean {
    if (this.stopped) return false;
    if (this.deliveredKeys.has(trigger.key)) return false;
    if (this.waiting.some((w) => w.trigger.key === trigger.key)) return false;
    this.waiting.push({ trigger, offeredAtMs: this.deps.clock.now() });
    this.pump();
    return true;
  }

  /** Decide now. Called on every offer, when the coalesce window closes,
   *  and by whoever sees the Director become idle. */
  pump(): void {
    if (this.stopped || this.delivering || this.waiting.length === 0) return;
    if (!this.deps.isDirectorIdle()) return;
    const batch = this.nextBatch();
    if (batch === null) return;
    this.send(batch);
  }

  get pending(): readonly DirectorTrigger[] {
    return this.waiting.map((w) => w.trigger);
  }

  stop(): void {
    this.stopped = true;
    if (this.windowTimer !== null) this.deps.clock.clearTimeout(this.windowTimer);
    this.windowTimer = null;
  }

  /** The next turn, or null when nothing may go yet (a window still open). */
  private nextBatch(): Waiting[] | null {
    const now = this.deps.clock.now();
    const windowMs = this.deps.coalesceWindowMs();
    let earliestWindowClose: number | null = null;

    for (const priority of PRIORITY_ORDER) {
      const atPriority = this.waiting.filter(
        (w) => DIRECTOR_TRIGGER_RULES[w.trigger.kind].priority === priority,
      );
      if (atPriority.length === 0) continue;

      // Every waiting user message of one conversation goes together, and
      // nothing else with them.
      const users = atPriority.filter((w) => w.trigger.kind === 'user_message');
      if (users.length > 0) return sameConversation(users, users[0]!);

      const alone = atPriority.find((w) => !DIRECTOR_TRIGGER_RULES[w.trigger.kind].coalesces);
      if (alone !== undefined) return [alone];

      // Coalescing: the window runs from the oldest one waiting, and when it
      // closes every coalescing trigger of that one's conversation goes in
      // one turn. The others wait for the next.
      const oldest = Math.min(...atPriority.map((w) => w.offeredAtMs));
      if (now - oldest >= windowMs) {
        const coalescing = this.waiting.filter(
          (w) => DIRECTOR_TRIGGER_RULES[w.trigger.kind].coalesces,
        );
        return sameConversation(
          coalescing,
          atPriority.find((w) => w.offeredAtMs === oldest)!,
        );
      }
      const closes = oldest + windowMs;
      earliestWindowClose =
        earliestWindowClose === null ? closes : Math.min(earliestWindowClose, closes);
    }

    if (earliestWindowClose !== null) this.armWindow(earliestWindowClose - now);
    return null;
  }

  private armWindow(ms: number): void {
    if (this.windowTimer !== null) this.deps.clock.clearTimeout(this.windowTimer);
    this.windowTimer = this.deps.clock.setTimeout(() => {
      this.windowTimer = null;
      this.pump();
    }, ms);
  }

  private send(batch: Waiting[]): void {
    const sent = new Set(batch);
    this.waiting = this.waiting.filter((w) => !sent.has(w));
    for (const w of batch) this.rememberDelivered(w.trigger.key);
    const triggers = batch.map((w) => w.trigger);
    this.delivering = true;
    const putBack = (): void => {
      for (const t of triggers) this.deliveredKeys.delete(t.key);
      this.waiting = [...batch, ...this.waiting];
    };
    void this.deps
      .deliverTurn({
        triggers,
        conversationId: triggers[0]?.conversationId ?? null,
        text: triggers.map((t) => t.text).join('\n\n---\n\n'),
      })
      .then((outcome) => {
        // M11 row S1-19: not spent now (the Director's budget is gone).
        // They wait, in front, for the next pump; nothing is lost.
        if (outcome === 'deferred') putBack();
      })
      .catch((err: unknown) => {
        // Not delivered: put them back, in front, and let them be offered
        // again. A message is still undelivered in the outbox either way.
        putBack();
        console.error('[director triggers] a turn could not be delivered:', err);
      })
      .finally(() => {
        this.delivering = false;
      });
  }

  private rememberDelivered(key: string): void {
    this.deliveredKeys.add(key);
    if (this.deliveredKeys.size > DELIVERED_KEYS_KEPT) {
      const oldest = this.deliveredKeys.values().next().value;
      if (oldest !== undefined) this.deliveredKeys.delete(oldest);
    }
  }
}

export interface DirectorHeartbeatDeps {
  readonly clock: TriggerClock;
  /** `reporting.heartbeatMinutes`, read at each beat. */
  readonly intervalMs: () => number;
  /**
   * The newest event that is news to the Director. Production excludes the
   * Director's own work and the chat traffic it takes part in, so its own
   * last turn is never the reason for its next one.
   */
  readonly latestEventSeq: () => number;
  readonly queue: DirectorTriggerQueue;
}

/**
 * §26.1's heartbeat: "only if new events exist". Each beat compares the
 * newest event with the one the last heartbeat covered, and offers a
 * trigger only when there is something new. A beat with nothing new does
 * nothing, which is what keeps the heartbeat from being a bare-timer wake.
 */
export function startDirectorHeartbeat(deps: DirectorHeartbeatDeps): { stop(): void } {
  let reportedThrough = deps.latestEventSeq();
  let handle: unknown = null;
  let stopped = false;

  const beat = (): void => {
    if (stopped) return;
    const latest = deps.latestEventSeq();
    if (latest > reportedThrough) {
      deps.queue.offer({
        kind: 'heartbeat',
        key: `heartbeat:${latest}`,
        conversationId: null,
        text: 'Heartbeat: there has been activity since your last report. Check the project state and report progress if anything changed.',
      });
      reportedThrough = latest;
    }
    handle = deps.clock.setTimeout(beat, deps.intervalMs());
  };
  handle = deps.clock.setTimeout(beat, deps.intervalMs());

  return {
    stop: () => {
      stopped = true;
      if (handle !== null) deps.clock.clearTimeout(handle);
    },
  };
}
