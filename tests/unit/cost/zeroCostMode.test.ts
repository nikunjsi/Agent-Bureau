import { describe, expect, it } from 'vitest';
import { refuseSpawnIfZeroCost, canEnableZeroCostMode } from '../../../src/main/cost/zeroCostMode';
import type { ProbeResult } from '../../../src/shared/engine/types';

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    installed: true,
    authenticated: true,
    version: null,
    binaryPath: null,
    error: null,
    metered: true,
    ...overrides,
  };
}

describe('refuseSpawnIfZeroCost (§24.5 — a hard guarantee, not a budget)', () => {
  it('never refuses when zero-cost mode is off, regardless of metered', () => {
    expect(refuseSpawnIfZeroCost(false, probe({ metered: true }))).toEqual({
      refused: false,
      reason: null,
    });
    expect(refuseSpawnIfZeroCost(false, probe({ metered: false }))).toEqual({
      refused: false,
      reason: null,
    });
  });

  it('refuses a metered engine when zero-cost mode is on', () => {
    const result = refuseSpawnIfZeroCost(true, probe({ metered: true }));
    expect(result.refused).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it('allows a genuinely non-metered engine when zero-cost mode is on', () => {
    const result = refuseSpawnIfZeroCost(true, probe({ metered: false }));
    expect(result).toEqual({ refused: false, reason: null });
  });

  it('never infers metered from anything other than probe.metered — the same probe field decides regardless of other probe fields', () => {
    // installed:false / authenticated:false / error set — none of these
    // change the verdict; only `metered` does. §24.5: "DO NOT INFER
    // metered FROM pricing.yaml — a missing rate means 'usage not
    // reported', not 'free'" — this test is the analogous guard for the
    // probe's OTHER fields, at the enforcement point itself.
    const brokenButUnmetered = probe({
      installed: false,
      authenticated: false,
      error: 'not found',
      metered: false,
    });
    expect(refuseSpawnIfZeroCost(true, brokenButUnmetered)).toEqual({
      refused: false,
      reason: null,
    });
  });
});

describe('canEnableZeroCostMode (§24.5 — the Director case: refuses to enable rather than strand the Director)', () => {
  it('refuses an unrecognised engine string outright — the safe direction, never a guessed "probably free"', async () => {
    const result = await canEnableZeroCostMode('some-future-engine-with-no-real-adapter');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('refuses an empty/unset engine string, with a reason that says so rather than silently defaulting', async () => {
    const result = await canEnableZeroCostMode('');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('(none configured)');
  });

  // The claude-code branch's own real-probe test lives in
  // tests/integration/cost/zeroCostMode.test.ts — a real `claude auth
  // status` subprocess spawn (§7.1: "MUST finish < 5s") comfortably
  // exceeds this suite's fast unit-test timeout but not the integration
  // tier's 30s one, matching claudeCodeAdapter.test.ts's own precedent of
  // never calling the real probe() from a unit test.
});
