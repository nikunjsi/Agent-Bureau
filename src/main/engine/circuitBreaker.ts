/**
 * §11.5 — the circuit breaker's pure, unit-testable pieces. `Supervisor`
 * owns the stateful sequencing (interrupt → steer → constrain → stop,
 * the trigger checks themselves, the escalation timer) — this file only
 * holds logic that doesn't need a live adapter/DB to test, matching
 * `budgetCheck.ts`/`budgetEnforcement.ts`'s own split from M6 session 2.
 */

export type BreakerTrigger =
  'token_velocity' | 'repeated_tool_calls' | 'error_storm' | 'wall_clock_overrun';

export interface TimestampedTokens {
  readonly at: number;
  readonly tokens: number;
}

/**
 * The rolling token-velocity window: prune anything older than `windowMs`
 * relative to `now`, then sum what's left — the same prune-then-reduce
 * shape `LoopDetector.recordAndCheck` already uses for prune-then-count,
 * applied to a sum instead of a count since velocity is a rate, not an
 * occurrence tally.
 */
export function pruneAndSumTokens(
  entries: readonly TimestampedTokens[],
  now: number,
  windowMs: number,
): { kept: readonly TimestampedTokens[]; sum: number } {
  const cutoff = now - windowMs;
  const kept = entries.filter((e) => e.at > cutoff);
  const sum = kept.reduce((total, e) => total + e.tokens, 0);
  return { kept, sum };
}

/**
 * §11.5's own exact corrective text, verbatim — one constant so the
 * wording is testable in isolation and only ever written once.
 */
export const STEER_MESSAGE =
  'You appear to be repeating the same action. Stop, and report what is blocking you using bureau_task_blocked.';

function describeTrigger(trigger: BreakerTrigger, detail: Record<string, unknown>): string {
  switch (trigger) {
    case 'token_velocity':
      return `token usage exceeded the configured rate (${JSON.stringify(detail)})`;
    case 'repeated_tool_calls':
      return 'the same tool call was repeated too many times in a short window';
    case 'error_storm':
      return `too many tool calls failed in a short window (${JSON.stringify(detail)})`;
    case 'wall_clock_overrun':
      return `this task has run far longer than its role's own wall-clock timeout (${JSON.stringify(detail)})`;
    default: {
      const _exhaustive: never = trigger;
      return _exhaustive;
    }
  }
}

export interface BreakerCheckpointInput {
  readonly type: 'blocker';
  readonly urgency: 'blocking';
  readonly title: string;
  readonly context: string;
  readonly options: Array<{ id: string; label: string; consequence: string }>;
  readonly preview: null;
  readonly default_action: null;
}

/**
 * The blocker checkpoint's own title/context/options — §11.5 prescribes
 * the steer sequence but not this checkpoint's exact wording, so this is
 * a real, reasonable construction, kept in one testable place rather
 * than inlined at the one call site. One real option with a real
 * consequence (invariant #8: every checkpoint option states its
 * consequence) — there is nothing else safe to offer here, since
 * resuming or dismissing the stop is a decision M8/M9's checkpoint
 * system, not this one, is responsible for making possible.
 */
export function buildBreakerBlockerCheckpointInput(
  trigger: BreakerTrigger,
  detail: Record<string, unknown> = {},
): BreakerCheckpointInput {
  return {
    type: 'blocker',
    urgency: 'blocking',
    title: `Employee stopped by the circuit breaker (${trigger})`,
    context: `This employee was stopped after repeated corrective attempts failed to resolve the problem: ${describeTrigger(trigger, detail)}.`,
    options: [
      {
        id: 'acknowledge',
        label: 'Acknowledge',
        consequence:
          'Marks this as seen. The task stays blocked until reassigned or otherwise resolved.',
      },
    ],
    preview: null,
    // "Acknowledge" is not a safe default to apply on a clock — it would
    // mark a stopped employee as seen while nobody has seen it. §9.5: no
    // safe default, no expiry.
    default_action: null,
  };
}
