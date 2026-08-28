/**
 * §10.3: lease TTL is `role.wall_clock_timeout_s + 5 min`, renewed on
 * every heartbeat. Roles are M7 — `2400` is not a re-guessed number, it's
 * the real `roles.wall_clock_timeout_s` schema default
 * (`src/shared/models/role.ts`), named here so the two can't silently
 * drift apart. `300` is the `+5min` from §10.3, also named rather than
 * inlined. M7 substitutes the real per-role value by passing it as the
 * parameter — nothing about the lease code changes; no settings key was
 * invented for this (trap h/i).
 */
export const DEFAULT_WALL_CLOCK_TIMEOUT_S = 2400;
export const LEASE_TTL_BUFFER_S = 300;

export function computeLeaseTtlSeconds(roleWallClockTimeoutS?: number): number {
  return (roleWallClockTimeoutS ?? DEFAULT_WALL_CLOCK_TIMEOUT_S) + LEASE_TTL_BUFFER_S;
}
