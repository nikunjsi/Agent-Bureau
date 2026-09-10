/**
 * Presentation-only formatting for the window shell — the title bar,
 * the floor pane, the employee bar.
 *
 * Same contract as `chat/format.ts`, and worth restating because it is the
 * boundary this project keeps having to defend: every function here turns
 * a **fact the Core sent** into a string a person reads, and none of them
 * decides anything. The Core says `todayUsdMicros: null` and
 * `unmeteredEmployeeCount: 1`; the sentence those facts deserve is written
 * here, where a rebuilt shell is free to write a different one. No payload
 * carries a pre-formatted string, a colour, an icon or a button label.
 *
 * A sibling of `chat/format.ts` rather than an addition to it: that file
 * belongs to the chat view and this one to the shell around it, and this
 * UI is provisional enough that the two are likely to be redesigned apart.
 */
import { microsToUsd } from '../../../shared/models/money';

export interface SpendMeterText {
  /** The visible label in the title bar. */
  readonly label: string;
  /** The accessible name and tooltip — a whole sentence, since a screen
   * reader gets no help from the `⏱` next to it. */
  readonly description: string;
}

/**
 * §14.1's `⏱` meter.
 *
 * **Three facts, three renderings, and the bug was collapsing them.**
 *
 *   `undefined` — the summary has not come back yet. Not a number, and
 *                 not a claim about money.
 *   `null`      — the Core answered, and nothing that spent anything today
 *                 reported a cost. CLAUDE.md's named trap: this is
 *                 "cost not reported", never `$0.00`.
 *   a number    — a real, complete total, including a real `0`.
 *
 * `TitleBar` rendered `…` for both of the first two and never saw the
 * third, because `costs.summary` used to return SQL NULL for an empty
 * ledger — so a fresh install showed a loading ellipsis that never
 * resolved. The handler now separates the empty ledger from the
 * unreported one; this separates all three.
 *
 * `unmeteredEmployeeCount` is §14.1's disclosure: *"the header total
 * silently omitting an employee's real (unknown) cost must never look like
 * a complete number."* It qualifies a total — so it is deliberately NOT
 * appended while loading, where there is no total to qualify yet.
 */
export function describeSpendMeter(
  todayUsdMicros: number | null | undefined,
  unmeteredEmployeeCount: number,
): SpendMeterText {
  if (todayUsdMicros === undefined) {
    return {
      label: 'working out today',
      description: 'Working out what today has cost.',
    };
  }

  const disclosure = unmeteredDisclosure(unmeteredEmployeeCount);

  if (todayUsdMicros === null) {
    return {
      label: `cost not reported${disclosure.labelSuffix}`,
      description: `Cost was not reported for anything that ran today.${disclosure.sentence}`,
    };
  }

  const amount = `$${microsToUsd(todayUsdMicros).toFixed(2)}`;
  return {
    label: `${amount} today${disclosure.labelSuffix}`,
    description: `${amount} spent today.${disclosure.sentence}`,
  };
}

function unmeteredDisclosure(count: number): { labelSuffix: string; sentence: string } {
  if (count <= 0) return { labelSuffix: '', sentence: '' };
  const employees = count === 1 ? '1 employee' : `${count} employees`;
  return {
    labelSuffix: ` · cost not reported for ${employees}`,
    sentence:
      ` This total leaves out ${employees} whose engine reports no cost,` +
      ' so the real figure is higher by an unknown amount.',
  };
}

/**
 * §9.4's checkpoint count, for the title bar's `🔔`.
 *
 * A function rather than an interpolation at the call site because the
 * count is also the accessible name, and the two drifting apart is exactly
 * what AUDIT #7 found: the bell read `🔔 0` with `aria-label="0
 * notifications"`, both hardcoded, while the real pending count sat one
 * selector away in the same store.
 */
export function describeCheckpointBell(pendingCount: number): SpendMeterText {
  if (pendingCount === 0) {
    return { label: '0', description: 'Nothing is waiting for you.' };
  }
  const noun = pendingCount === 1 ? 'decision is' : 'decisions are';
  return {
    label: String(pendingCount),
    description: `${pendingCount} ${noun} waiting for you.`,
  };
}
