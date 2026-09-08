import type { ProbeResult } from '../../shared/engine/types';

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
 */
export async function canEnableZeroCostMode(engine: string): Promise<EnableZeroCostModeCheck> {
  switch (engine) {
    case 'claude-code': {
      const { ClaudeCodeAdapter } = await import('../engine/claudeCodeAdapter');
      const probe = await new ClaudeCodeAdapter().probe();
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
