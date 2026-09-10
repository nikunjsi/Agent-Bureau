import { describe, expect, it } from 'vitest';
import { describeSpendMeter } from '../../../src/renderer/src/components/format';

/**
 * AUDIT M0–M2 #7 — §14.1's `⏱` meter, and the three facts it has to keep
 * apart.
 *
 * `TitleBar` held one `number | null` and rendered `…` for null, which
 * collapsed two completely different states onto one glyph: a request that
 * has not come back yet, and a Core that answered "nobody reported a
 * cost". CLAUDE.md names the second as a trap of its own — *do not show
 * `$0.00` for an engine that does not report usage; show "cost not
 * reported"* — and the transport was built to carry the distinction
 * (AUDIT #18). The renderer threw it away, and because an empty ledger
 * also arrived as null, a fresh install sat on a loading ellipsis forever.
 *
 * So: `undefined` is *not asked yet*, `null` is *nobody knows*, `0` is a
 * real and complete answer. This is the function that keeps them separate,
 * and it decides nothing — it turns facts the Core sent into words, the
 * same contract `chat/format.ts` states for itself.
 *
 * The wiring — that `TitleBar` actually calls this, with the real value
 * from the real handler — is `tests/e2e/titleBar.spec.ts`, against the
 * real packaged app. A green file here says the sentences are right, not
 * that anything renders them (standing rule 1).
 */
describe('describeSpendMeter (§14.1) — three states, never conflated', () => {
  describe('the three states are all distinguishable', () => {
    it('undefined is "not asked yet" and says so, rather than showing a number', () => {
      const meter = describeSpendMeter(undefined, 0);
      expect(meter.label).not.toContain('$');
      expect(meter.description.toLowerCase()).toContain('working out');
    });

    it('null is "no engine reported a cost" — never $0.00', () => {
      const meter = describeSpendMeter(null, 0);
      expect(meter.label).not.toContain('$0.00');
      expect(meter.label.toLowerCase()).toContain('not reported');
      expect(meter.description.toLowerCase()).toContain('not reported');
    });

    it('0 is a real, complete answer and renders as money', () => {
      const meter = describeSpendMeter(0, 0);
      expect(meter.label).toContain('$0.00');
      expect(meter.label.toLowerCase()).not.toContain('not reported');
    });

    it('a real amount renders in dollars from micros', () => {
      expect(describeSpendMeter(2_140_000, 0).label).toContain('$2.14');
    });

    it('no two of the three states produce the same label', () => {
      const labels = [
        describeSpendMeter(undefined, 0).label,
        describeSpendMeter(null, 0).label,
        describeSpendMeter(0, 0).label,
      ];
      expect(new Set(labels).size, 'two distinct system states rendered identically').toBe(3);
    });
  });

  /**
   * §14.1: "If any employee running today is unmetered (§11.5.1 —
   * `usageReporting: false`), the meter's tooltip/label MUST say so (e.g.
   * *"$2.14 today · cost not reported for 1 employee"*) — the header total
   * silently omitting an employee's real (unknown) cost must never look
   * like a complete number."
   */
  describe('§14.1s unmetered disclosure', () => {
    it('says nothing when every employee reports usage', () => {
      expect(describeSpendMeter(2_140_000, 0).label).toBe('$2.14 today');
    });

    it('discloses one unmetered employee alongside a real total', () => {
      const meter = describeSpendMeter(2_140_000, 1);
      expect(meter.label).toContain('$2.14');
      expect(
        meter.label.toLowerCase(),
        'a total that omits an unmetered employee, presented as if complete',
      ).toContain('not reported');
      expect(meter.label).toContain('1 employee');
    });

    it('pluralises, because the label is read by a person', () => {
      expect(describeSpendMeter(2_140_000, 3).label).toContain('3 employees');
      expect(describeSpendMeter(2_140_000, 1).label).not.toContain('employees');
    });

    it('discloses in the accessible name too, not only the visible label (§14.7)', () => {
      const meter = describeSpendMeter(2_140_000, 2);
      expect(meter.description).toContain('2 employees');
    });

    it('still discloses when nothing at all reported a cost', () => {
      const meter = describeSpendMeter(null, 2);
      expect(meter.description).toContain('2 employees');
    });

    it('does not claim a complete zero when an unmetered employee exists', () => {
      const meter = describeSpendMeter(0, 1);
      expect(meter.label).toContain('$0.00');
      expect(
        meter.label.toLowerCase(),
        '$0.00 with an unmetered employee on the roster reads as "this was free"',
      ).toContain('not reported');
    });

    it('says nothing about unmetered employees while still loading — there is no total to qualify', () => {
      expect(describeSpendMeter(undefined, 2).label).not.toContain('2 employees');
    });
  });

  /**
   * The Core sends facts; this file writes the sentence (CLAUDE.md's
   * boundary rule, and M9's `remedy.kind` precedent). Nothing here should
   * be reachable only from a pre-formatted string the Core built.
   */
  it('is a pure function of the two facts the Core sends', () => {
    expect(describeSpendMeter(1_000_000, 0)).toEqual(describeSpendMeter(1_000_000, 0));
  });
});
