import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getSetting } from '../db/repositories/settings';
import { getUsageSince, type SpendBeforeAfter } from '../db/repositories/usage';
import { getProjectById } from '../db/repositories/projects';
import { insertCheckpoint } from '../db/repositories/checkpoints';
import {
  checkAllLevels,
  localMidnightIso,
  type BudgetLevel,
  type LevelCheckInput,
} from './budgetCheck';

export type OnExceedVerdict = 'park' | 'ask' | 'stop';

export interface BudgetEnforcementInput {
  employeeId: string;
  isDirector: boolean;
  projectId: string | null;
  taskId: string | null;
  /** This turn's authoritative cost (`usage.cost_usd_micros`, already
   * resolved — engine-reported or Bureau-computed). Used to derive the
   * two daily levels' before/after via subtraction from a single
   * post-insert `getUsageSince` call, rather than a second, racy query. */
  costMicros: number;
  /** From `insertUsage`'s own return — already computed inside the same
   * transaction as the write, so "before" is exactly what preceded this
   * row, not subject to a concurrent-write race. */
  taskSpend: SpendBeforeAfter | null;
  projectSpend: SpendBeforeAfter | null;
  roleBudgetMicros: number | null;
  employeeDailyBudgetMicros: number | null;
}

export interface BudgetEnforcementResult {
  /** `null` when nothing crossed a hard limit this turn — no action needed. */
  verdict: OnExceedVerdict | null;
  mostSevereLevel: BudgetLevel | null;
}

/**
 * §11.5/§16.1/§8.0 — the DB-aware glue around `budgetCheck.ts`'s pure
 * logic: resolves the four levels' real before/after/budget values,
 * calls `checkAllLevels`, emits ONE event per level that actually
 * crossed a threshold this turn (never one collapsed "most severe"
 * event — reporting and enforcement are different jobs), and returns the
 * single most-severe outcome as the verdict the caller (Supervisor) acts
 * on.
 *
 * **Director reserve — a carve-out at two levels, not an exemption at
 * either.** Exempting the Director from `globalDailyUsd` entirely would
 * make the setting stop capping total spend (advisory only) — a bigger
 * change to what the setting means than the anti-deadlock rule justifies
 * (§8.0 only describes the project-level interaction explicitly). So:
 * non-Director employees stop at `(budget - directorReserveUsd)` at BOTH
 * the project and global-daily levels; the Director may draw to the
 * FULL budget at both. `perEmployeeDailyUsd` stays a genuine, total
 * exemption for the Director — §8.0 states that one explicitly, unlike
 * the other two.
 *
 * **"Even the reserve is exhausted"** falls out of this construction for
 * free: when `isDirector` is true, the Director's own check already uses
 * the FULL (non-carved-out) ceiling, so the Director hitting `exceeded`
 * at the project or global-daily level genuinely means nothing is left
 * — exactly the case that raises the approval checkpoint.
 */
export function enforceBudget(
  db: Database.Database,
  activityLog: ActivityLog,
  input: BudgetEnforcementInput,
): BudgetEnforcementResult {
  const warnAtPct = getSetting(db, 'budgets.warnAtPct');
  const onExceed = getSetting(db, 'budgets.onExceed');
  const directorReserveMicros = getSetting(db, 'budgets.directorReserveUsd');
  const midnightIso = localMidnightIso();

  const task: LevelCheckInput | null = input.taskSpend
    ? {
        beforeMicros: input.taskSpend.beforeMicros,
        afterMicros: input.taskSpend.afterMicros,
        budgetMicros: input.roleBudgetMicros ?? getSetting(db, 'budgets.perTaskUsd'),
      }
    : null;

  const project: LevelCheckInput | null = input.projectSpend
    ? {
        beforeMicros: input.projectSpend.beforeMicros,
        afterMicros: input.projectSpend.afterMicros,
        budgetMicros: reserveCarveOut(
          input.isDirector,
          (input.projectId ? getProjectById(db, input.projectId)?.budget_usd_micros : null) ??
            getSetting(db, 'budgets.projectUsd'),
          directorReserveMicros,
        ),
      }
    : null;

  // Two daily-scoped levels: no denormalised counter exists for either
  // (§16.1 — nothing resets one at local midnight), so "before" is
  // derived by subtracting this turn's own cost from a single post-
  // insert ledger sum, rather than a second racy query.
  const employeeDaily: LevelCheckInput | null = input.isDirector
    ? null // §8.0: a genuine, total exemption — not a carve-out
    : (() => {
        const afterMicros = getUsageSince(db, midnightIso, { employeeId: input.employeeId });
        return {
          beforeMicros: afterMicros - input.costMicros,
          afterMicros,
          budgetMicros:
            input.employeeDailyBudgetMicros ?? getSetting(db, 'budgets.perEmployeeDailyUsd'),
        };
      })();

  const globalDaily: LevelCheckInput = (() => {
    const afterMicros = getUsageSince(db, midnightIso);
    return {
      beforeMicros: afterMicros - input.costMicros,
      afterMicros,
      budgetMicros: reserveCarveOut(
        input.isDirector,
        getSetting(db, 'budgets.dailyUsd'),
        directorReserveMicros,
      ),
    };
  })();

  const { perLevel, mostSevere } = checkAllLevels(
    { task, project, employeeDaily, globalDaily },
    warnAtPct,
  );

  for (const { level, result } of perLevel) {
    if (result.crossedWarnThisTurn) {
      logBudgetEvent(activityLog, 'employee.budget_warning', input, level);
      logBudgetEvent(activityLog, 'cost.budget_threshold', input, level);
    }
    if (result.crossedExceededThisTurn) {
      logBudgetEvent(activityLog, 'employee.budget_exceeded', input, level);
    }
  }

  if (mostSevere === null || mostSevere.outcome !== 'exceeded') {
    return { verdict: null, mostSevereLevel: mostSevere?.level ?? null };
  }

  // The Director's own check used the FULL budget (no carve-out) — if
  // IT is exceeded, the reserve itself is gone. §8.0: raise the real
  // approval checkpoint; the "raise budget" button is M9's UI, this is
  // the real, callable action + record.
  if (input.isDirector && (mostSevere.level === 'project' || mostSevere.level === 'globalDaily')) {
    raiseBudgetExhaustedCheckpoint(db, activityLog, input.projectId, mostSevere.level);
  }

  return { verdict: onExceed, mostSevereLevel: mostSevere.level };
}

/**
 * M11 row S1-19, §8.0: is the Director's own budget — the FULL budget, the
 * reserve included — spent, at the project or the global-daily level?
 * Answered before a turn is spent rather than after, so an exhausted
 * Director spawns nothing. The same ceilings `enforceBudget` uses for the
 * Director, read without a turn: no carve-out, and no per-employee daily
 * level (§8.0 exempts the Director from it entirely). Null when there is
 * money left.
 */
export function directorBudgetExhausted(
  db: Database.Database,
  projectId: string | null,
): 'project' | 'globalDaily' | null {
  if (projectId !== null) {
    const project = getProjectById(db, projectId);
    const budget = project?.budget_usd_micros ?? getSetting(db, 'budgets.projectUsd');
    if (project !== null && project.spend_usd_micros >= budget) return 'project';
  }
  const spentToday = getUsageSince(db, localMidnightIso());
  return spentToday >= getSetting(db, 'budgets.dailyUsd') ? 'globalDaily' : null;
}

function reserveCarveOut(
  isDirector: boolean,
  fullBudgetMicros: number,
  reserveMicros: number,
): number {
  return isDirector ? fullBudgetMicros : fullBudgetMicros - reserveMicros;
}

function logBudgetEvent(
  activityLog: ActivityLog,
  type: 'employee.budget_warning' | 'cost.budget_threshold' | 'employee.budget_exceeded',
  input: BudgetEnforcementInput,
  level: BudgetLevel,
): void {
  activityLog.logEvent({
    actor: 'system',
    type,
    severity: type === 'employee.budget_exceeded' ? 'warn' : 'info',
    project_id: input.projectId,
    task_id: input.taskId,
    employee_id: input.employeeId,
    checkpoint_id: null,
    payload: { level },
  });
}

/**
 * §8.0: "If even the reserve is exhausted, the chat shows a plain system
 * message with a 'raise budget' button that works without any model
 * call." The button's rendering and click-wiring are M9's (no chat UI
 * exists) — this is the real, durable record of the situation, and the
 * option's real action (`setSetting(db, 'budgets.projectUsd'|'dailyUsd',
 * ...)`, already a real, callable, no-model-call function) is what a
 * future UI wires the button to, not a placeholder.
 *
 * No `expires_at`/`default_action` — §5.1's own CHECK constraint (a
 * checkpoint whose every option is irreversible has no safe default)
 * applies here exactly as it did to M5's merge-conflict checkpoint:
 * "raise the budget" and "cut scope" are both real, consequential
 * choices, neither a safe default to auto-resolve to.
 */
function raiseBudgetExhaustedCheckpoint(
  db: Database.Database,
  activityLog: ActivityLog,
  projectId: string | null,
  level: BudgetLevel,
): void {
  insertCheckpoint(db, activityLog, {
    project_id: projectId,
    task_id: null,
    employee_id: null,
    type: 'approval',
    urgency: 'blocking',
    title: 'Budget exhausted — the Director has no funds left to work with',
    context:
      level === 'project'
        ? "This project's budget (including the Director's own reserve) has been fully spent."
        : "Today's global budget (including the Director's own reserve) has been fully spent.",
    options: [
      {
        id: 'raise_budget',
        label: 'Raise the budget',
        consequence: 'Increases the spending limit so work can continue immediately.',
      },
      {
        id: 'cut_scope',
        label: 'Cut scope instead',
        consequence: 'Work stays paused until the budget resets or you raise it manually later.',
      },
    ],
    preview: null,
    // No safe default: "raise the budget" and "cut scope" are both real,
    // consequential choices. §9.5 therefore gives this checkpoint no
    // expiry at all, derived by insertCheckpoint rather than stated here.
    default_action: null,
  });
}
