/**
 * §7.10's long-poll mechanism: "the Core holds it open while the
 * permission checkpoint is pending, up to `permissions.maxHoldMinutes`."
 *
 * The interim evaluator (policyEvaluator.ts) is strictly binary — it
 * never produces an 'ask' outcome, since a real 'ask' needs a real
 * checkpoint system (M8), which does not exist. So nothing in this
 * session's production path ever calls `create()` — but the hold
 * mechanism itself has to be real and exercised through the actual HTTP
 * endpoint, not a separate untested class, because M6's real evaluator
 * (and M8's real checkpoints) will call this directly, unchanged, the
 * day they exist. server.ts's evaluator is injectable specifically so
 * tests can make it return 'ask' and drive this for real.
 *
 * Keyed by callId, not employeeId — multiple in-flight tool calls for the
 * same employee are possible in principle (the architecture does not rule
 * it out, e.g. a future SDK path with parallel tool calls) and get fully
 * independent holds; nothing about one interferes with another.
 */
export type PolicyHoldVerdict = 'allow' | 'deny';

/**
 * "The same employee issues a second policy check while one is held" (M4
 * session 1 prompt) — answered concretely: two *different* callIds from
 * the same employee are two fully independent holds (every real tool call
 * gets its own callId; nothing about this registry keys on employeeId
 * except the employee-dies sweep). The same callId held twice can only
 * mean a client bug (a retried request must use `/v1/tool/:name`'s
 * idempotency key, not resend a policy check with a stale callId) —
 * server.ts catches this specific error and turns it into a clean
 * `VALIDATION_FAILED`, not an uncaught throw.
 */
export class DuplicateHoldError extends Error {
  constructor(callId: string) {
    super(`a hold for callId ${callId} already exists — callId must be unique per tool call`);
    this.name = 'DuplicateHoldError';
  }
}

interface PendingHold {
  employeeId: string;
  timer: ReturnType<typeof setTimeout>;
  settle: (verdict: PolicyHoldVerdict) => void;
}

export class PolicyHoldRegistry {
  private readonly holds = new Map<string, PendingHold>();

  /**
   * Creates a hold and returns a promise resolving once it's settled —
   * by an explicit `resolve()`, by `resolveAllForEmployee()` (the
   * employee-dies-mid-hold case), or by timing out. A timeout auto-
   * resolves to `deny` — CLAUDE.md invariant #6 ("expired ... → the safe
   * option") and #7 ("a checkpoint timeout never causes an irreversible
   * action"): letting a tool call proceed because nobody answered in time
   * is the one outcome those invariants exist to rule out.
   */
  create(callId: string, employeeId: string, maxHoldMs: number): Promise<PolicyHoldVerdict> {
    if (this.holds.has(callId)) {
      throw new DuplicateHoldError(callId);
    }
    return new Promise<PolicyHoldVerdict>((resolve) => {
      const settle = (verdict: PolicyHoldVerdict): void => {
        const pending = this.holds.get(callId);
        if (!pending) return; // already settled
        clearTimeout(pending.timer);
        this.holds.delete(callId);
        resolve(verdict);
      };
      const timer = setTimeout(() => settle('deny'), maxHoldMs);
      this.holds.set(callId, { employeeId, timer, settle });
    });
  }

  /** Explicit resolution — what a real checkpoint-answer flow (M8) will call. Returns false if the hold no longer exists (already settled or never existed). */
  resolve(callId: string, verdict: PolicyHoldVerdict): boolean {
    const pending = this.holds.get(callId);
    if (!pending) return false;
    pending.settle(verdict);
    return true;
  }

  /**
   * The employee-dies-mid-hold case: a held request outliving the process
   * that made it leaks a connection and a decision nobody will ever read
   * (the employee is gone; even 'allow' has no tool call left to unblock).
   * Denies and settles every hold for that employee. Returns the count
   * terminated, for the caller's own logging.
   */
  resolveAllForEmployee(employeeId: string, verdict: PolicyHoldVerdict = 'deny'): number {
    // Collect first, settle after — settling mutates the map (deletes the
    // entry), and doing that while still iterating it is exactly the kind
    // of subtlety not worth relying on being safe.
    const toSettle = [...this.holds.values()].filter(
      (pending) => pending.employeeId === employeeId,
    );
    for (const pending of toSettle) pending.settle(verdict);
    return toSettle.length;
  }

  /** Diagnostic only. */
  get pendingCount(): number {
    return this.holds.size;
  }
}
