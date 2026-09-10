import { describe, expect, it } from 'vitest';
import {
  refuseSpawnIfZeroCost,
  canEnableZeroCostMode,
  zeroCostVerdictFromProbe,
} from '../../../src/main/cost/zeroCostMode';
import type { ProbeResult } from '../../../src/shared/engine/types';

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    installed: true,
    authenticated: true,
    version: null,
    binaryPath: null,
    error: null,
    metered: true,
    determination: 'determined',
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
  // status` subprocess spawn comfortably exceeds this suite's fast
  // unit-test timeout but not the integration tier's 30s one, matching
  // claudeCodeAdapter.test.ts's own precedent of never calling the real
  // probe() from a unit test. Note that §7.8's liveness ceiling is now 30s
  // — equal to the integration tier's timeout, not inside it — which is a
  // second reason the real-probe branch does not belong in a unit suite.
});

describe('zeroCostVerdictFromProbe (§7.8 — the settings toggle is the one user-facing probe)', () => {
  it('an indeterminate probe refuses, and says the check did not finish — never that the CLI is missing', () => {
    // The user-visible half of this session's fix. `canEnableZeroCostMode`
    // is the only genuinely user-facing probe caller, and before the fix a
    // cold first launch told the user their CLI was not installed. It was
    // installed. It was 318.7 MB and Defender was reading it.
    const verdict = zeroCostVerdictFromProbe(
      probe({
        determination: 'indeterminate',
        installed: false,
        authenticated: false,
        metered: true,
        error: 'probe() did not finish within its 2500ms budget (§7.8)',
      }),
    );

    // Fail closed — invariant #6 is unchanged, and enabling zero-cost mode
    // on an unconfirmed engine would strand the user with no Director.
    expect(verdict.allowed).toBe(false);
    // Honest in message — the half that is new.
    expect(verdict.reason).toContain('did not finish in time');
    expect(verdict.reason.toLowerCase()).not.toContain('not installed');
    expect(verdict.reason.toLowerCase()).not.toContain('is metered');
    // And it names the action that actually works.
    expect(verdict.reason).toContain('try again');
  });

  it('a determined "not installed" still says not installed — the new state must not swallow the old one', () => {
    const verdict = zeroCostVerdictFromProbe(
      probe({
        determination: 'determined',
        installed: false,
        metered: true,
        error: '"claude" was not found on the resolved PATH (§15.4).',
      }),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('not installed');
  });

  it('a determined, genuinely metered engine still blames metering, not the check', () => {
    const verdict = zeroCostVerdictFromProbe(
      probe({ determination: 'determined', installed: true, metered: true }),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('metered');
    expect(verdict.reason).not.toContain('did not finish in time');
  });

  it('a determined, confirmed subscription is allowed', () => {
    const verdict = zeroCostVerdictFromProbe(
      probe({ determination: 'determined', installed: true, metered: false }),
    );

    expect(verdict.allowed).toBe(true);
  });
});
