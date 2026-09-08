/**
 * §11.5/§16.1 — pure budget-threshold logic, no DB access. The
 * before/after values bracket exactly one increment (one turn's cost),
 * so `warn`/`exceeded` fire only on the turn that actually crosses a
 * threshold — never on every subsequent turn while already over. No
 * "already warned" tracking state anywhere: the crossing IS the state,
 * recomputed fresh from real counters each time.
 */
export type BudgetLevel = 'task' | 'project' | 'employeeDaily' | 'globalDaily';
export type LevelOutcome = 'ok' | 'warn' | 'exceeded';

export interface LevelCheckInput {
  readonly beforeMicros: number;
  readonly afterMicros: number;
  /** `null` or `<= 0` means "no budget configured at this level" — always `ok`. */
  readonly budgetMicros: number | null;
}

export interface LevelCheckResult {
  readonly outcome: LevelOutcome;
  /** Fires exactly on the turn that crosses the warn threshold, and only
   * while still under the hard limit — an `exceeded` turn doesn't also
   * report a same-turn warn crossing (exceeded already supersedes it). */
  readonly crossedWarnThisTurn: boolean;
  /** Fires exactly on the turn that crosses the hard limit. `outcome ===
   * 'exceeded'` can be true on a LATER turn too (still over budget) without
   * this being true again — `isOverBudget` (`outcome === 'exceeded'`) is
   * the enforcement signal (idempotent, safe to act on repeatedly);
   * `crossedExceededThisTurn` is the one-time reporting signal. */
  readonly crossedExceededThisTurn: boolean;
}

export function checkLevel(input: LevelCheckInput, warnAtPct: number): LevelCheckResult {
  if (input.budgetMicros === null || input.budgetMicros <= 0) {
    return { outcome: 'ok', crossedWarnThisTurn: false, crossedExceededThisTurn: false };
  }
  const isOverBudget = input.afterMicros >= input.budgetMicros;
  const crossedExceededThisTurn = input.beforeMicros < input.budgetMicros && isOverBudget;

  const warnThresholdMicros = Math.floor((input.budgetMicros * warnAtPct) / 100);
  const crossedWarnThisTurn =
    !isOverBudget &&
    input.beforeMicros < warnThresholdMicros &&
    input.afterMicros >= warnThresholdMicros;

  return {
    outcome: isOverBudget ? 'exceeded' : crossedWarnThisTurn ? 'warn' : 'ok',
    crossedWarnThisTurn,
    crossedExceededThisTurn,
  };
}

export interface LevelInputs {
  /** `null` when this usage row has no task_id (no per-task budget to check). */
  readonly task: LevelCheckInput | null;
  /** `null` when there is no project attribution for this row. */
  readonly project: LevelCheckInput | null;
  /** `null` when exempt — the Director, per §8.0, exempt from `perEmployeeDailyUsd` entirely. */
  readonly employeeDaily: LevelCheckInput | null;
  /** Always checked — the Director draws on the reserve here too (see
   * budgetEnforcement.ts's own comment on why this is a reserve carve-out,
   * not an exemption, at this level and at `project`). */
  readonly globalDaily: LevelCheckInput;
}

export interface PerLevelResult {
  readonly level: BudgetLevel;
  readonly result: LevelCheckResult;
}

export interface AllLevelsResult {
  /** Every level that was actually checked (excludes `null` inputs) —
   * `budgetEnforcement.ts` emits one event per entry here whose
   * `crossedWarnThisTurn`/`crossedExceededThisTurn` is true, regardless
   * of which level ends up `mostSevere`. Reporting and enforcement are
   * different jobs: every real crossing gets its own event; only the
   * single most severe outcome drives what the caller (Supervisor) does. */
  readonly perLevel: readonly PerLevelResult[];
  readonly mostSevere: {
    readonly level: BudgetLevel;
    readonly outcome: 'warn' | 'exceeded';
  } | null;
}

const LEVEL_ORDER: BudgetLevel[] = ['task', 'project', 'employeeDaily', 'globalDaily'];

/** Checks every level with a non-null input, in `LEVEL_ORDER`. The
 * returned `mostSevere` is `exceeded` > `warn` > (absent); among equal
 * severities the first level in `LEVEL_ORDER` wins attribution — stated
 * explicitly rather than left as an implementation accident. */
export function checkAllLevels(inputs: LevelInputs, warnAtPct: number): AllLevelsResult {
  const byLevel: Record<BudgetLevel, LevelCheckInput | null> = {
    task: inputs.task,
    project: inputs.project,
    employeeDaily: inputs.employeeDaily,
    globalDaily: inputs.globalDaily,
  };

  const perLevel: PerLevelResult[] = [];
  for (const level of LEVEL_ORDER) {
    const input = byLevel[level];
    if (input === null) continue;
    perLevel.push({ level, result: checkLevel(input, warnAtPct) });
  }

  let mostSevere: AllLevelsResult['mostSevere'] = null;
  for (const { level, result } of perLevel) {
    if (result.outcome === 'ok') continue;
    if (
      mostSevere === null ||
      (result.outcome === 'exceeded' && mostSevere.outcome !== 'exceeded')
    ) {
      mostSevere = { level, outcome: result.outcome };
    }
  }

  return { perLevel, mostSevere };
}

/** Local midnight (the machine's own timezone) as a UTC ISO string —
 * every `usage.ts` column already stores UTC ISO, so a single instant's
 * UTC representation is the correct comparison value regardless of
 * offset. §11.5.1: "Day boundary is local midnight in the user's
 * timezone." */
export function localMidnightIso(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
}
