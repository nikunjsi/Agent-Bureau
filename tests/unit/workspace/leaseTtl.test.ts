import { describe, expect, it } from 'vitest';
import {
  computeLeaseTtlSeconds,
  DEFAULT_WALL_CLOCK_TIMEOUT_S,
  LEASE_TTL_BUFFER_S,
} from '../../../src/main/workspace/leaseTtl';

describe('computeLeaseTtlSeconds (trap h)', () => {
  it('falls back to the schema default (2400) + 300 when no role value is supplied', () => {
    expect(computeLeaseTtlSeconds()).toBe(2700);
    expect(computeLeaseTtlSeconds(undefined)).toBe(2700);
  });

  it('uses the real per-role value once M7 supplies one, without any other change', () => {
    expect(computeLeaseTtlSeconds(1200)).toBe(1500);
    expect(computeLeaseTtlSeconds(0)).toBe(300); // 0 is a valid (if unusual) role timeout, not "missing"
  });

  it("the fallback constant equals roles.wall_clock_timeout_s's real schema default, not a re-guessed number", () => {
    expect(DEFAULT_WALL_CLOCK_TIMEOUT_S).toBe(2400);
    expect(LEASE_TTL_BUFFER_S).toBe(300);
  });
});
