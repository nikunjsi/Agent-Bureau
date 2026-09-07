import { describe, expect, it } from 'vitest';
import {
  pruneAndSumTokens,
  buildBreakerBlockerCheckpointInput,
  STEER_MESSAGE,
} from '../../../src/main/engine/circuitBreaker';

describe('pruneAndSumTokens (§11.5 token-velocity trigger)', () => {
  it('sums only entries within the window, pruning anything older', () => {
    const now = 100_000;
    const entries = [
      { at: now - 70_000, tokens: 1000 }, // outside a 60s window
      { at: now - 30_000, tokens: 2000 }, // inside
      { at: now - 5_000, tokens: 3000 }, // inside
    ];
    const { kept, sum } = pruneAndSumTokens(entries, now, 60_000);
    expect(sum).toBe(5000);
    expect(kept).toHaveLength(2);
  });

  it('returns 0/empty for no entries', () => {
    const { kept, sum } = pruneAndSumTokens([], 100_000, 60_000);
    expect(sum).toBe(0);
    expect(kept).toEqual([]);
  });

  it("an entry exactly at the cutoff boundary is excluded (strictly greater than cutoff, matching LoopDetector's own convention)", () => {
    const now = 100_000;
    const windowMs = 60_000;
    const cutoff = now - windowMs;
    const { sum } = pruneAndSumTokens([{ at: cutoff, tokens: 500 }], now, windowMs);
    expect(sum).toBe(0);
  });

  it('all entries within the window are kept and summed', () => {
    const now = 100_000;
    const entries = [
      { at: now - 1000, tokens: 100 },
      { at: now - 2000, tokens: 200 },
      { at: now, tokens: 300 },
    ];
    const { sum } = pruneAndSumTokens(entries, now, 60_000);
    expect(sum).toBe(600);
  });
});

describe('STEER_MESSAGE (§11.5 exact text)', () => {
  it("matches the spec's own literal wording", () => {
    expect(STEER_MESSAGE).toBe(
      'You appear to be repeating the same action. Stop, and report what is blocking you using bureau_task_blocked.',
    );
  });
});

describe('buildBreakerBlockerCheckpointInput (invariant #8: every option states its consequence)', () => {
  it('produces a real blocker checkpoint shape for each trigger', () => {
    const triggers = [
      'token_velocity',
      'repeated_tool_calls',
      'error_storm',
      'wall_clock_overrun',
    ] as const;
    for (const trigger of triggers) {
      const input = buildBreakerBlockerCheckpointInput(trigger, { some: 'detail' });
      expect(input.type).toBe('blocker');
      expect(input.urgency).toBe('blocking');
      expect(input.title).toContain(trigger);
      expect(input.context.length).toBeGreaterThan(0);
      expect(input.options.length).toBeGreaterThan(0);
      for (const option of input.options) {
        expect(option.consequence.length).toBeGreaterThan(0);
      }
      // §5.1's own CHECK: a checkpoint whose every option is irreversible
      // has no safe default, so it never expires. M8 moved the second half
      // of that pair out of this builder — `expires_at` is now DERIVED by
      // insertCheckpoint from the null default, rather than restated here
      // by every caller — so the input no longer carries the field at all.
      expect(input.default_action).toBeNull();
      expect(input).not.toHaveProperty('expires_at');
    }
  });

  it('works with no detail object at all (the default)', () => {
    const input = buildBreakerBlockerCheckpointInput('wall_clock_overrun');
    expect(input.context.length).toBeGreaterThan(0);
  });
});
