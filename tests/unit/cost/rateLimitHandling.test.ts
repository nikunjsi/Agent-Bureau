import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  resolveResumeAt,
  buildQuotaExhaustedCheckpointText,
} from '../../../src/main/cost/rateLimitHandling';
import type { PricingTable } from '../../../src/shared/models/pricing';

describe('backoffDelayMs (§24.3: "exponential backoff with jitter — 2s, 5s, 15s, 45s, cap 2m")', () => {
  it('follows the exact schedule at zero jitter (random() = 0.5, the midpoint)', () => {
    const noJitter = () => 0.5; // (0.5*2 - 1) = 0 => no deviation from base
    expect(backoffDelayMs(0, noJitter)).toBe(2_000);
    expect(backoffDelayMs(1, noJitter)).toBe(5_000);
    expect(backoffDelayMs(2, noJitter)).toBe(15_000);
    expect(backoffDelayMs(3, noJitter)).toBe(45_000);
  });

  it('caps at 2 minutes for attempt 4 and beyond, even with maximal jitter', () => {
    const maxJitter = () => 1; // pushes jitter fully positive
    expect(backoffDelayMs(4, maxJitter)).toBe(120_000);
    expect(backoffDelayMs(10, maxJitter)).toBe(120_000);
  });

  it('never exceeds the 2-minute cap even for a late schedule step plus positive jitter', () => {
    const maxJitter = () => 1;
    // 45_000 base + 20% jitter = 54_000, well under the cap — sanity check
    // the cap logic still holds at a non-capped step.
    expect(backoffDelayMs(3, maxJitter)).toBeLessThanOrEqual(120_000);
  });

  it('never goes negative even with maximal negative jitter', () => {
    const minJitter = () => 0;
    expect(backoffDelayMs(0, minJitter)).toBeGreaterThanOrEqual(0);
  });

  it('jitter varies the delay within +/-20% of the base for a mid-schedule step', () => {
    const base = 15_000; // attempt 2
    const withJitter = backoffDelayMs(2, () => 1); // full positive jitter
    expect(withJitter).toBeGreaterThan(base);
    expect(withJitter).toBeLessThanOrEqual(base * 1.2);
  });
});

describe('resolveResumeAt (§24.3: never invent a reset time)', () => {
  const now = new Date('2026-08-29T12:00:00.000Z');

  it('falls back to now + 1h, known:false, when the engine has no pricing entry at all', () => {
    const pricing: PricingTable = {
      version: 1,
      verified_at: 'x',
      verified_against: 'x',
      engines: {},
    };
    const result = resolveResumeAt(pricing, 'claude-code', now);
    expect(result.known).toBe(false);
    expect(result.resumeAtIso).toBe(new Date(now.getTime() + 60 * 60_000).toISOString());
  });

  it('falls back to now + 1h, known:false, when quota_reset.kind is "unknown" — claude-code\'s real, researched value', () => {
    const pricing: PricingTable = {
      version: 1,
      verified_at: 'x',
      verified_against: 'x',
      engines: { 'claude-code': { models: {}, quota_reset: { kind: 'unknown' } } },
    };
    const result = resolveResumeAt(pricing, 'claude-code', now);
    expect(result.known).toBe(false);
    expect(result.resumeAtIso).toBe(new Date(now.getTime() + 60 * 60_000).toISOString());
  });

  it('falls back to now + 1h when pricing itself is null', () => {
    const result = resolveResumeAt(null, 'claude-code', now);
    expect(result.known).toBe(false);
  });

  it('a rolling window resolves to now + windowMinutes, known:true', () => {
    const pricing: PricingTable = {
      version: 1,
      verified_at: 'x',
      verified_against: 'x',
      engines: {
        'some-engine': { models: {}, quota_reset: { kind: 'rolling', window_minutes: 300 } },
      },
    };
    const result = resolveResumeAt(pricing, 'some-engine', now);
    expect(result.known).toBe(true);
    expect(result.resumeAtIso).toBe(new Date(now.getTime() + 300 * 60_000).toISOString());
  });

  it("a daily reset in a fixed-offset zone (no DST) resolves to today's reset hour when still ahead", () => {
    const pricing: PricingTable = {
      version: 1,
      verified_at: 'x',
      verified_against: 'x',
      engines: {
        'some-engine': {
          models: {},
          quota_reset: { kind: 'daily', hour: 18, timezone: 'Asia/Kolkata' },
        },
      },
    };
    // Asia/Kolkata is UTC+5:30, fixed offset, no DST — deterministic.
    const result = resolveResumeAt(pricing, 'some-engine', now); // now = 12:00 UTC = 17:30 IST
    expect(result.known).toBe(true);
    // 18:00 IST today = 12:30 UTC today — still ahead of 12:00 UTC "now".
    expect(result.resumeAtIso).toBe('2026-08-29T12:30:00.000Z');
  });

  it('a daily reset already passed today rolls to tomorrow, same zone', () => {
    const pricing: PricingTable = {
      version: 1,
      verified_at: 'x',
      verified_against: 'x',
      engines: {
        'some-engine': {
          models: {},
          quota_reset: { kind: 'daily', hour: 10, timezone: 'Asia/Kolkata' },
        },
      },
    };
    // 10:00 IST = 04:30 UTC, already passed relative to 12:00 UTC "now".
    const result = resolveResumeAt(pricing, 'some-engine', now);
    expect(result.resumeAtIso).toBe('2026-08-30T04:30:00.000Z');
  });

  it('a daily reset in plain UTC resolves exactly, both directions', () => {
    const pricing: PricingTable = {
      version: 1,
      verified_at: 'x',
      verified_against: 'x',
      engines: {
        'some-engine': { models: {}, quota_reset: { kind: 'daily', hour: 15, timezone: 'UTC' } },
      },
    };
    expect(resolveResumeAt(pricing, 'some-engine', now).resumeAtIso).toBe(
      '2026-08-29T15:00:00.000Z',
    );

    const pricingPast: PricingTable = {
      version: 1,
      verified_at: 'x',
      verified_against: 'x',
      engines: {
        'some-engine': { models: {}, quota_reset: { kind: 'daily', hour: 9, timezone: 'UTC' } },
      },
    };
    expect(resolveResumeAt(pricingPast, 'some-engine', now).resumeAtIso).toBe(
      '2026-08-30T09:00:00.000Z',
    );
  });
});

describe('buildQuotaExhaustedCheckpointText (§24.3 exact template)', () => {
  it('uses the literal fallback phrase, never a fabricated duration, when the reset is unknown', () => {
    const text = buildQuotaExhaustedCheckpointText('claude-code', {
      resumeAtIso: '2026-08-29T13:00:00.000Z',
      known: false,
    });
    expect(text).toBe(
      "We've used up today's free quota for claude-code. Work is paused and will resume automatically when we retry in an hour. You can also connect a paid key in Settings to continue now.",
    );
  });

  it('renders a real time (not the fallback phrase) when the reset is known', () => {
    const text = buildQuotaExhaustedCheckpointText('some-engine', {
      resumeAtIso: '2026-08-29T18:00:00.000Z',
      known: true,
    });
    expect(text).toContain("We've used up today's free quota for some-engine.");
    expect(text).toContain('You can also connect a paid key in Settings to continue now.');
    expect(text).not.toContain('when we retry in an hour');
    expect(text).toMatch(/resume automatically at \d/);
  });
});
