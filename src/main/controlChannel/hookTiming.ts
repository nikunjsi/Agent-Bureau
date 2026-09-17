import type Database from 'better-sqlite3';
import { getSetting } from '../db/repositories/settings';
import { UserFacingError } from '../../shared/errors/userFacing';

/**
 * §7.10's three durations, resolved from real settings in one place (S-1).
 *
 * 1. `permissions.maxHoldMinutes`: how long the Core holds a permission
 *    question open for a person.
 * 2. The registered PreToolUse hook timeout: `maxHoldMinutes + 5 min`. When it
 *    expires the ENGINE gives up on the hook, and a timed-out hook fails OPEN.
 * 3. `permissions.hookSelfDeadlineMs`: how long `bureau-hook` waits before it
 *    denies on its own. It must be strictly less than (2), or the engine's
 *    fail-open timeout could decide instead of the hook's deny.
 */
export interface HookTiming {
  readonly maxHoldMinutes: number;
  readonly hookSelfDeadlineMs: number;
  readonly registeredHookTimeoutSeconds: number;
}

export const HOOK_TIMEOUT_MARGIN_MINUTES = 5;

/** The registered defaults, for a caller with no settings database. */
export const DEFAULT_HOOK_TIMING: HookTiming = {
  maxHoldMinutes: 30,
  hookSelfDeadlineMs: 30 * 60_000,
  registeredHookTimeoutSeconds: (30 + HOOK_TIMEOUT_MARGIN_MINUTES) * 60,
};

/** A setting combination under which a permission question could be let
 *  through by a timeout. The message is for the person who set it. */
export class HookTimingInvalidError extends UserFacingError {}

export function validateHookTiming(timing: HookTiming): HookTiming {
  if (
    !Number.isFinite(timing.hookSelfDeadlineMs) ||
    timing.hookSelfDeadlineMs <= 0 ||
    timing.hookSelfDeadlineMs >= timing.registeredHookTimeoutSeconds * 1000
  ) {
    throw new HookTimingInvalidError(
      `The permission settings conflict: Bureau's own wait for a permission answer (${Math.round(timing.hookSelfDeadlineMs / 60_000)} min) must be shorter than ${timing.maxHoldMinutes + HOOK_TIMEOUT_MARGIN_MINUTES} min (the permission hold time plus ${HOOK_TIMEOUT_MARGIN_MINUTES} min). Otherwise a tool call could go ahead without an answer. Lower "hook self-deadline" or raise "max hold minutes" in Advanced settings.`,
    );
  }
  return timing;
}

export function resolveHookTiming(db: Database.Database): HookTiming {
  const maxHoldMinutes = getSetting(db, 'permissions.maxHoldMinutes');
  return validateHookTiming({
    maxHoldMinutes,
    hookSelfDeadlineMs: getSetting(db, 'permissions.hookSelfDeadlineMs'),
    registeredHookTimeoutSeconds: (maxHoldMinutes + HOOK_TIMEOUT_MARGIN_MINUTES) * 60,
  });
}
