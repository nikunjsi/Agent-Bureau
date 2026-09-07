import type Database from 'better-sqlite3';
import { getSetting } from '../db/repositories/settings';
import type { CheckpointType, CheckpointUrgency } from '../../shared/models/enums';

/**
 * §9.5's timeouts, derived in **exactly one place**.
 *
 * Before M8 nothing ever set `expires_at`, and `NewCheckpointInput`
 * accepted one from the caller — five call sites that all happened to pass
 * `null`. The field is now gone from that input and computed here instead,
 * because a deadline decided by both the caller and a helper is the
 * write-only-decision-input shape standing rule 6 names.
 *
 * ## Two rules, in this order
 *
 * **1. No safe default, no expiry.** §9.5: "A timeout never results in an
 * irreversible action. If the only options are irreversible, the
 * checkpoint cannot time out and the task stays parked indefinitely."
 * That is CLAUDE.md invariant #7, and it is expressed here as a single
 * structural fact rather than a rule the sweep has to remember: a
 * checkpoint with `default_action === null` gets `expires_at === null`, so
 * the sweep's own query cannot select it. §5.1's CHECK constraint and
 * `CheckpointSchema`'s refine both pin the same relationship from the
 * other side.
 *
 * **2. `permission` uses the hold's clock, not the checkpoint's.** A
 * permission checkpoint's real deadline is how long the Core holds the
 * agent's HTTP request open — `permissions.maxHoldMinutes` (§7.10). §7.10
 * already reconciles THREE durations by hand (the Core's hold, the
 * engine's registered hook timeout, and `bureau-hook`'s own self-deadline)
 * and says explicitly why they are "three separate, explicitly reconciled
 * numbers rather than one assumed deadline". Adding a fourth —
 * `checkpoints.blockingTimeoutMinutes` — that must silently agree with the
 * first would undo that work. So the row carries the hold's own deadline,
 * and `server.ts` derives the hold's duration back out of the row: one
 * number, in one place, read by both.
 */
export interface ExpiryInput {
  readonly type: CheckpointType;
  readonly urgency: CheckpointUrgency;
  readonly default_action: string | null;
}

export interface CheckpointTimeoutSettings {
  readonly blockingTimeoutMinutes: number;
  readonly soonTimeoutHours: number;
  readonly maxHoldMinutes: number;
}

/** Read once, from the same registry every other consumer uses. */
export function loadCheckpointTimeoutSettings(db: Database.Database): CheckpointTimeoutSettings {
  return {
    blockingTimeoutMinutes: getSetting(db, 'checkpoints.blockingTimeoutMinutes'),
    soonTimeoutHours: getSetting(db, 'checkpoints.soonTimeoutHours'),
    maxHoldMinutes: getSetting(db, 'permissions.maxHoldMinutes'),
  };
}

/**
 * Returns the ISO instant this checkpoint expires at, or `null` for one
 * that never does. `nowMs` is injected rather than read from the clock so
 * the post-restart-grace and timeout tests can drive real instants without
 * faking timers.
 */
export function computeExpiresAt(
  input: ExpiryInput,
  settings: CheckpointTimeoutSettings,
  nowMs: number,
): string | null {
  // Rule 1 — and it comes first deliberately. It is not an optimisation
  // to skip it for `permission`: a permission checkpoint always has a
  // hardcoded `deny` default, so it always passes this gate anyway, and
  // ordering the checks this way means invariant #7 is the FIRST thing
  // anyone reading this function sees.
  if (input.default_action === null) return null;

  if (input.type === 'permission') {
    return new Date(nowMs + settings.maxHoldMinutes * 60_000).toISOString();
  }

  switch (input.urgency) {
    case 'blocking':
      return new Date(nowMs + settings.blockingTimeoutMinutes * 60_000).toISOString();
    case 'soon':
      return new Date(nowMs + settings.soonTimeoutHours * 3_600_000).toISOString();
    case 'whenever':
      // §9.5: "`whenever` → no expiry." A safe default still exists and is
      // still what an explicit answer-by-default would apply; nothing is
      // ever applied to it on a clock.
      return null;
  }
}
