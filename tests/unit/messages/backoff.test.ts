import { describe, expect, it } from 'vitest';
import { DELIVERY_BACKOFF_MS, nextAttemptDelayMs } from '../../../src/main/messages/router';

/**
 * §9.7's retry rule, verbatim: "5 s → 30 s → 2 min → 10 min → 30 min, then
 * `dead_letter`." The ladder is one table with one reader, so this is the
 * whole policy.
 */
describe('§9.7 retry backoff', () => {
  it('is exactly the ladder the spec names', () => {
    expect(DELIVERY_BACKOFF_MS).toEqual([5_000, 30_000, 120_000, 600_000, 1_800_000]);
  });

  it('walks the ladder one rung per failed attempt', () => {
    expect(nextAttemptDelayMs(1)).toBe(5_000);
    expect(nextAttemptDelayMs(2)).toBe(30_000);
    expect(nextAttemptDelayMs(3)).toBe(120_000);
    expect(nextAttemptDelayMs(4)).toBe(600_000);
    expect(nextAttemptDelayMs(5)).toBe(1_800_000);
  });

  it('returns null past the end of the ladder — that is the dead letter', () => {
    // Six delivery attempts in total, spanning ~43 minutes, and then §9.7's
    // dead letter. `null` is not "no delay"; it is "stop retrying", which is
    // why the caller branches on it rather than defaulting.
    expect(nextAttemptDelayMs(6)).toBeNull();
    expect(nextAttemptDelayMs(99)).toBeNull();
  });

  it('treats a message that has never been attempted as due immediately-ish', () => {
    expect(nextAttemptDelayMs(0)).toBe(5_000);
  });
});
