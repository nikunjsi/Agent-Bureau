import type { ProbeResult } from '../../shared/engine/types';
import { PROBE_RESPONSIVENESS_BUDGET_MS } from '../../shared/engine/types';

export interface ZeroCostRefusal {
  refused: boolean;
  reason: string | null;
}

export class ZeroCostSpawnRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ZeroCostSpawnRefusedError';
  }
}

/**
 * §24.5: `settings.costs.zeroCostMode` is a hard guarantee, not a budget.
 * `probe.metered` is the one fact that makes it enforceable — never
 * inferred from `pricing.yaml`. A missing rate there means "usage not
 * reported" (§11.5.1), not "free"; conflating the two would silently
 * disable this guarantee, which is §24.5's own explicit warning, worth
 * restating here since it's exactly the mistake this function exists to
 * avoid making. An adapter that cannot positively confirm otherwise
 * reports `metered: true` (the safe direction, §24.5's own rule), so
 * "can't tell" refuses exactly like "definitely metered" does.
 *
 * §7.8's `determination` is deliberately NOT read here. An indeterminate
 * probe carries `metered: true`, so this function already refuses it, and it
 * refuses for a reason that is still true — the billing genuinely was not
 * confirmed. What an indeterminate probe needs beyond that is a *different
 * refusal message*, and its caller (`Supervisor.assign()`) refuses on it by
 * name before ever reaching this function, so the wording here would never
 * be the one shown. Reading it in both places would be two owners for one
 * decision — standing rule 6.
 */
export function refuseSpawnIfZeroCost(
  zeroCostModeEnabled: boolean,
  probe: ProbeResult,
): ZeroCostRefusal {
  if (!zeroCostModeEnabled) return { refused: false, reason: null };
  if (!probe.metered) return { refused: false, reason: null };
  return {
    refused: true,
    reason:
      'Zero-cost mode is on and this engine is metered (or its billing could not be confirmed) — refusing to spawn rather than risk a real charge.',
  };
}

export interface EnableZeroCostModeCheck {
  allowed: boolean;
  reason: string;
}

/**
 * §24.5 + §7.8, applied to one probe result. Split out of
 * `canEnableZeroCostMode` below purely so it can be tested: that function
 * constructs its own adapter on purpose, so every branch of this decision
 * would otherwise be reachable only by launching the real CLI in whatever
 * state the machine happens to be in.
 */
export function zeroCostVerdictFromProbe(probe: ProbeResult): EnableZeroCostModeCheck {
  // Checked BEFORE `metered`, even though an indeterminate probe always
  // reports `metered: true` and would refuse on the next branch anyway. The
  // refusal is the same; the sentence is not. "claude-code is metered" is a
  // claim about the user's account that this probe did not verify, and
  // sending someone off to check their billing when the real problem was a
  // slow first launch of a 318.7 MB CLI is the specific harm §7.8's third
  // state exists to stop.
  if (probe.determination === 'indeterminate') {
    return {
      allowed: false,
      reason: `The check on claude-code did not finish in time (${probe.error ?? 'no further detail'}), so its billing could not be confirmed — zero-cost mode stays off rather than risk a real charge. This is usually a slow first launch of a large CLI; try again in a moment.`,
    };
  }
  if (probe.metered) {
    return {
      allowed: false,
      reason: probe.installed
        ? 'claude-code is metered (or its billing could not be confirmed) — zero-cost mode would leave nobody able to run the Director.'
        : `claude-code is not installed or not authenticated (${probe.error ?? 'unknown reason'}) — cannot confirm it would be free.`,
    };
  }
  return { allowed: true, reason: 'claude-code reports subscription (non-metered) auth.' };
}

/**
 * §24.5: "if the only MCP-capable engine is metered, zero-cost mode
 * cannot run the Director... Bureau refuses to enable the setting and
 * explains why, rather than starting in a state where the user cannot
 * talk to anyone." Probes `engine` FRESH — `claude auth status` is
 * documented as "free, local, no API spend" (confirmed by reading
 * `ClaudeCodeAdapter.probe()`'s own comment), so this is safe to call at
 * settings-toggle time, not just at employee-spawn time. Refuses unless
 * the probe positively confirms the engine is NOT metered — covers both
 * "positively metered" (a real API key) and "can't tell", the same
 * safe-direction rule as `refuseSpawnIfZeroCost`: enabling zero-cost mode
 * against an engine that turns out metered-or-unknown would immediately
 * strand the user with no way to run the Director at all, which is a
 * worse failure than declining to enable the setting.
 *
 * Lazy dynamic import, same reasoning as `toolClassify.ts`'s own: a
 * top-level import of `ClaudeCodeAdapter` drags in `electron` via
 * `resourceScripts.ts`, breaking anything that merely loads this module
 * without ever calling this function — found for real in M6 session 1,
 * not a defensive guess.
 *
 * ## §7.8's budget: this is the one caller with a person waiting
 *
 * A user is holding a settings toggle, so this takes
 * `PROBE_RESPONSIVENESS_BUDGET_MS` — 2.5s, above the measured warm p99 of
 * 2024ms and deliberately below the cold case. A cold probe therefore comes
 * back `indeterminate` here, on purpose, and `zeroCostVerdictFromProbe`'s
 * first branch exists to say so honestly rather than blame the user's install.
 *
 * ## It does not use `ProbeCache`, and that is a decision, not an omission
 *
 * Two reasons, and the second is the one that matters. First, it *cannot*:
 * `ProbeCache` keys on adapter **identity** via a `WeakMap` (deliberately —
 * see its own comment on `CLAUDE_CONFIG_DIR`), and this constructs a fresh
 * `ClaudeCodeAdapter` every call, so every lookup would miss and every
 * result would be written under a key that is garbage before the next call.
 * Routing through the cache would add bookkeeping with a structurally
 * guaranteed 0% hit rate.
 *
 * Second, and independently: this is the exact moment a stale answer is
 * worst. The user reaching this toggle has plausibly *just* logged in or
 * installed the CLI, and serving them a 60s-old "metered, cannot confirm"
 * would refuse the setting for a minute after they fixed the thing it is
 * complaining about. A fresh probe is the right behaviour here even if a hit
 * were possible.
 *
 * Making it cacheable means sharing one process-wide adapter instance, which
 * is a wiring change belonging with the milestone that wires hiring —
 * recorded in `docs/NEXT-VERSION.md` §H.8 rather than done in passing.
 *
 * The verdict itself is `zeroCostVerdictFromProbe` below, split out for one
 * reason: every branch of it is a sentence shown to a user, and this
 * function cannot be tested without launching the real CLI (it constructs
 * its own adapter, deliberately — see above). A decision nobody can test is
 * how the "not installed" wording survived five occurrences unexamined.
 */

export async function canEnableZeroCostMode(engine: string): Promise<EnableZeroCostModeCheck> {
  switch (engine) {
    case 'claude-code': {
      const { ClaudeCodeAdapter } = await import('../engine/claudeCodeAdapter');
      const probe = await new ClaudeCodeAdapter().probe({
        budgetMs: PROBE_RESPONSIVENESS_BUDGET_MS,
      });
      return zeroCostVerdictFromProbe(probe);
    }
    default:
      // No other engine has a real adapter today (§24.1's own table:
      // "claude-code is the only engine with a real adapter, and it is
      // not free" is the actual v1 default position) — refusing an
      // unrecognised/unset engine string is the safe direction, not a
      // guess at a hypothetical free engine's behaviour.
      return {
        allowed: false,
        reason: `"${engine || '(none configured)'}" is not a recognised engine with a real adapter — cannot confirm it would be free to run the Director on.`,
      };
  }
}
