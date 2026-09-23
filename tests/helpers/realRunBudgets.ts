import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../../src/main/db/repositories/settings';

/**
 * The budgets every opt-in real run sets before it spends anything
 * (M11 plan rule 12, decision **E-7**). A real run is billed against a $5
 * prepaid key, and the shipping defaults ($20 daily, $2 per task) are not a
 * ceiling anyone would want on it.
 *
 * E-7's §S1 numbers. The gate (§GATE) has its own, larger set, and passes
 * them here rather than adding a second copy of this function.
 *
 * The reserve matters even in a test that hires no Director: a non-Director
 * employee's daily ceiling is `daily − reserve`, so the three move together
 * (that is the arithmetic E-7 exists to correct).
 */
export interface RealRunBudgets {
  readonly dailyUsd: number;
  readonly directorReserveUsd: number;
  readonly perTaskUsd: number;
}

/** E-7's §S1 row: `dailyUsd` $1, `directorReserveUsd` $0.25, `perTaskUsd` $0.25. */
export const S1_REAL_RUN_BUDGETS: RealRunBudgets = {
  dailyUsd: 1,
  directorReserveUsd: 0.25,
  perTaskUsd: 0.25,
};

/**
 * Writes the budgets and returns what they became in micro-dollars, so a
 * caller can assert the run really is capped rather than assume it (values
 * are decimal USD at the seam and integer micros everywhere after it —
 * invariant #12).
 */
export function applyRealRunBudgets(
  db: Database.Database,
  budgets: RealRunBudgets = S1_REAL_RUN_BUDGETS,
): { dailyMicros: number; directorReserveMicros: number; perTaskMicros: number } {
  setSetting(db, 'budgets.dailyUsd', budgets.dailyUsd);
  setSetting(db, 'budgets.directorReserveUsd', budgets.directorReserveUsd);
  setSetting(db, 'budgets.perTaskUsd', budgets.perTaskUsd);
  return {
    dailyMicros: getSetting(db, 'budgets.dailyUsd'),
    directorReserveMicros: getSetting(db, 'budgets.directorReserveUsd'),
    perTaskMicros: getSetting(db, 'budgets.perTaskUsd'),
  };
}

/**
 * Prints what a real run actually cost, from the engine's own usage
 * (`turn.completed`). M11 rule 12 requires the cost of every real run to be
 * written into its plan row, and the only place it exists is the run's own
 * output — so it is printed, not inferred later.
 *
 * Returns the total in micro-dollars, or null when the engine reported no
 * usage at all (CLAUDE.md: never show $0.00 for an engine that did not
 * report — say it did not report).
 */
export function reportRealRunCost(
  label: string,
  events: readonly {
    readonly t: string;
    readonly usage?: { costUsdMicros: number | null } | null;
  }[],
): number | null {
  const reported = events
    .filter((e) => e.t === 'turn.completed')
    .map((e) => e.usage?.costUsdMicros ?? null)
    .filter((c): c is number => c !== null);
  if (reported.length === 0) {
    console.log(`[real-run cost] ${label}: cost not reported by the engine`);
    return null;
  }
  const totalMicros = reported.reduce((a, b) => a + b, 0);
  console.log(
    `[real-run cost] ${label}: $${(totalMicros / 1_000_000).toFixed(4)} (${totalMicros} micro-dollars)`,
  );
  return totalMicros;
}
