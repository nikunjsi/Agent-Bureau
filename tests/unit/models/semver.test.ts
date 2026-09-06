import { describe, expect, it } from 'vitest';
import { compareSemver, satisfiesMinVersion, StrictSemverSchema } from '../../../src/shared/models/semver';

describe('StrictSemverSchema (§6.7 check 1)', () => {
  it('accepts exactly major.minor.patch', () => {
    for (const v of ['0.0.1', '1.0.0', '10.20.30', '0.0.0']) {
      expect(StrictSemverSchema.safeParse(v).success).toBe(true);
    }
  });

  // The reason this schema is strict rather than lenient: `compareSemver`
  // does not implement prerelease precedence, so anything carrying one must
  // be rejected at parse time rather than silently mis-ordered later.
  it('rejects prerelease and build metadata rather than mis-comparing them', () => {
    for (const v of ['1.0.0-beta', '1.0.0+build.5', '1.0.0-rc.1+exp', '1.0', '1', 'v1.0.0', '1.0.0.0', '']) {
      expect(StrictSemverSchema.safeParse(v).success).toBe(false);
    }
  });
});

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1); // not string order
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('compares numerically, not lexicographically', () => {
    // '9' > '10' as strings; the whole point of parsing to integers.
    expect(compareSemver('0.9.0', '0.10.0')).toBe(-1);
    expect(compareSemver('9.0.0', '10.0.0')).toBe(-1);
  });
});

describe('satisfiesMinVersion (the question check 1 actually asks)', () => {
  it('is true when the app is at or above the pack\'s floor', () => {
    expect(satisfiesMinVersion('1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesMinVersion('1.2.0', '1.0.0')).toBe(true);
  });

  it('is false when the app is below it', () => {
    // The real case today: package.json is 0.0.1, and §6.3's example pack
    // declares bureau_min_version 1.0.0 — so the spec's own illustrative
    // example does not install against the current build. Shipped packs
    // declare 0.0.1; see the note added to §6.3.
    expect(satisfiesMinVersion('0.0.1', '1.0.0')).toBe(false);
  });
});
