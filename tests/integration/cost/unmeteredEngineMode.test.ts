import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { GenericPtyAdapter } from '../../../src/main/engine/genericPtyAdapter';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { isUnmeteredEngine } from '../../../src/main/cost/unmeteredEmployees';
import type { EngineAdapter } from '../../../src/shared/engine/adapter';
import type { ProbeResult } from '../../../src/shared/engine/types';
import type { EngineMode } from '../../../src/shared/models/enums';

/**
 * AUDIT M0–M2 #7 — the guard `unmeteredEmployees.ts` names in its own doc,
 * and the reason that file is allowed to keep a table at all.
 *
 * §14.1's meter must disclose employees whose cost is unknown, and the
 * authoritative statement of "unknown" is `capabilities().usageReporting`
 * — which needs a constructed adapter and a completed probe. A title bar
 * cannot spawn a process per roster row to paint itself, so
 * `isUnmeteredEngine` answers from the `employees.engine`/`engine_mode`
 * columns instead. That is the same decision made in two places, which is
 * exactly what standing rule 6 says no test of either half can see.
 *
 * This is the test that spans both. It asks every shipped adapter what it
 * actually reports, in every mode, and requires the table to agree — so a
 * new engine, or an existing one changing its answer, fails here instead
 * of quietly making an incomplete total look like a complete one.
 *
 * It calls the real `capabilities()` rather than restating the table.
 * Restating it would make this a copy of the thing it is checking, which
 * is the M3–M6 audit's central finding in miniature.
 *
 * **This test wrote itself into being useful immediately.** Its first
 * version asserted that metering is a property of the mode alone — pty
 * unmetered, everything else metered — which is what §7.7.1's wording
 * suggests. Three of its ten cases failed on the first run:
 * `GenericPtyAdapter` ignores the mode entirely and reports
 * `usageReporting: false` in all of them, so an employee row with
 * `engine: 'generic-pty'` and a null `engine_mode` was unmetered in fact
 * and metered in the predicate — silently omitted from the disclosure,
 * which is the exact failure §14.1 exists to prevent. The predicate is
 * keyed on the engine as well as the mode because this test said so.
 */

/** `capabilities()` takes a probe, and no shipped adapter's answer to
 * `usageReporting` depends on it — they branch on `mode` alone. A
 * fail-closed placeholder keeps that honest: were some adapter to start
 * reading it, it would read safe values rather than flattering ones. */
const PROBE: ProbeResult = {
  installed: true,
  authenticated: true,
  version: null,
  binaryPath: null,
  error: null,
  determination: 'determined',
  metered: true,
};

/** Every mode an `employees.engine_mode` column can hold, `undefined`
 * standing for the NULL that means "the engine's own default". */
const MODES: ReadonlyArray<EngineMode | undefined> = ['structured', 'pty', undefined];

const ADAPTERS: ReadonlyArray<{ label: string; make: () => EngineAdapter }> = [
  { label: 'claude-code', make: () => new ClaudeCodeAdapter() },
  { label: 'generic-pty', make: () => new GenericPtyAdapter() },
  // A test double rather than a shipped engine, and included on purpose:
  // it is the one adapter whose key is absent from the table, so it also
  // proves the "unlisted engines are metered" default lines up with an
  // adapter that really does report usage.
  { label: 'fake', make: () => new FakeAdapter() },
];

describe('AUDIT #7: the cost layer and the adapters agree on what is unmetered', () => {
  for (const { label, make } of ADAPTERS) {
    for (const mode of MODES) {
      const modeLabel = mode ?? 'default (NULL engine_mode)';
      it(`${label} in ${modeLabel} mode`, () => {
        const adapter = make();
        const reportsUsage = adapter.capabilities(PROBE, mode).usageReporting;
        const treatedAsUnmetered = isUnmeteredEngine(adapter.key, mode ?? null);

        if (!reportsUsage) {
          // The direction that actually matters. An engine that reports no
          // usage while the cost layer calls it metered means real spend
          // is missing from the meter with nothing saying so — §14.1's
          // "must never look like a complete number", violated silently.
          expect(
            treatedAsUnmetered,
            `${adapter.key} does NOT report usage in ${modeLabel} mode, but ` +
              'isUnmeteredEngine treats it as metered, so §14.1s disclosure would omit it. ' +
              'Add it to UNMETERED_BY_ENGINE — or, if it is unmetered for a reason the ' +
              'engine/mode columns cannot express, move the decision somewhere that can ' +
              'consult capabilities().',
          ).toBe(true);
          return;
        }

        // The other direction is not harmless either, just quieter: the
        // meter would tell the user a cost is unknown when it is known,
        // which is a false claim about the product's own state (§1.5).
        expect(
          treatedAsUnmetered,
          `${adapter.key} DOES report usage in ${modeLabel} mode, but isUnmeteredEngine ` +
            'counts it as unmetered — the meter would disclose a cost it actually has.',
        ).toBe(false);
      });
    }
  }

  it('an engine nothing knows about is treated as metered, and the cases above are what makes that safe', () => {
    expect(isUnmeteredEngine('some-future-engine', null)).toBe(false);
    expect(isUnmeteredEngine('some-future-engine', 'pty')).toBe(false);
  });
});
