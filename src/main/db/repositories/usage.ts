import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import {
  UsageSchema,
  NewUsageInputSchema,
  type Usage,
  type NewUsageInput,
} from '../../../shared/models/usage';

export interface SpendBeforeAfter {
  readonly beforeMicros: number;
  readonly afterMicros: number;
}

export interface InsertUsageResult {
  readonly usage: Usage;
  /** `null` when this usage row has no task_id (the Director, or a
   * one-shot call) — the `tasks` UPDATE never ran, so there is no
   * before/after to report. */
  readonly taskSpend: SpendBeforeAfter | null;
  /** `null` when the caller supplied no `projectId` attribution — `usage`
   * itself has no `project_id` column (confirmed: no such column exists),
   * so the caller (Supervisor, via `ctx.task.project_id`) resolves it. */
  readonly projectSpend: SpendBeforeAfter | null;
  /** `null` only when this usage row has no `employee_id` at all (should
   * not happen for a real employee/Director turn, but the schema allows
   * it — e.g. a future one-shot call with no employee attribution). */
  readonly employeeLifetimeSpend: SpendBeforeAfter | null;
}

/**
 * §11.5.1's own literal SQL: one `BEGIN IMMEDIATE` transaction inserting
 * into `usage` and updating all three denormalised counters — "therefore
 * never disagree." Before this session, `insertUsage` was a bare INSERT
 * with no counter updates and no transaction at all; this is that gap,
 * closed. `attribution.projectId` is supplied by the caller (Supervisor
 * resolves it from `ctx.task.project_id` at assign() time) since `usage`
 * has no `project_id` column of its own.
 *
 * Returns real before/after spend for each counter actually touched —
 * what `budgetCheck.ts`'s stateless warn/exceeded crossing detection
 * needs (`before < threshold <= after`), computed inside the SAME
 * transaction so there is no window where a concurrent write could see a
 * different "before" than what genuinely preceded this row.
 */
export function insertUsage(
  db: Database.Database,
  input: NewUsageInput,
  attribution: { projectId: string | null } = { projectId: null },
): InsertUsageResult {
  const parsed = NewUsageInputSchema.parse(input);
  const id = newId();
  const ts = nowIso();
  // For counter arithmetic only — the stored `cost_usd_micros` column
  // stays the real, possibly-null value (§11.5.1: "cost not reported" is
  // a real state, never silently treated as $0 in what's DISPLAYED). An
  // unreported cost simply contributes +0 to every counter, which is
  // arithmetically a no-op — correct, since there is nothing to add.
  const costMicros = parsed.cost_usd_micros ?? 0;

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO usage (id, employee_id, task_id, project_id, engine, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost_usd_micros, computed_cost_usd_micros, turn_index, source, ts)
       VALUES (@id, @employee_id, @task_id, @project_id, @engine, @model, @tokens_in, @tokens_out, @tokens_cache_read, @tokens_cache_write, @cost_usd_micros, @computed_cost_usd_micros, @turn_index, @source, @ts)`,
    ).run({
      id,
      employee_id: parsed.employee_id,
      task_id: parsed.task_id,
      project_id: attribution.projectId,
      engine: parsed.engine,
      model: parsed.model,
      tokens_in: parsed.tokens_in,
      tokens_out: parsed.tokens_out,
      tokens_cache_read: parsed.tokens_cache_read,
      tokens_cache_write: parsed.tokens_cache_write,
      cost_usd_micros: parsed.cost_usd_micros,
      computed_cost_usd_micros: parsed.computed_cost_usd_micros,
      turn_index: parsed.turn_index,
      source: parsed.source,
      ts,
    });

    let taskSpend: SpendBeforeAfter | null = null;
    if (parsed.task_id) {
      const before =
        (
          db.prepare('SELECT spend_usd_micros FROM tasks WHERE id = ?').get(parsed.task_id) as
            { spend_usd_micros: number | null } | undefined
        )?.spend_usd_micros ?? 0;
      db.prepare(
        'UPDATE tasks SET spend_usd_micros = COALESCE(spend_usd_micros, 0) + ? WHERE id = ?',
      ).run(costMicros, parsed.task_id);
      taskSpend = { beforeMicros: before, afterMicros: before + costMicros };
    }

    let projectSpend: SpendBeforeAfter | null = null;
    if (attribution.projectId) {
      const before =
        (
          db
            .prepare('SELECT spend_usd_micros FROM projects WHERE id = ?')
            .get(attribution.projectId) as { spend_usd_micros: number } | undefined
        )?.spend_usd_micros ?? 0;
      db.prepare('UPDATE projects SET spend_usd_micros = spend_usd_micros + ? WHERE id = ?').run(
        costMicros,
        attribution.projectId,
      );
      projectSpend = { beforeMicros: before, afterMicros: before + costMicros };
    }

    let employeeLifetimeSpend: SpendBeforeAfter | null = null;
    if (parsed.employee_id) {
      const before =
        (
          db
            .prepare('SELECT lifetime_spend_usd_micros FROM employees WHERE id = ?')
            .get(parsed.employee_id) as { lifetime_spend_usd_micros: number } | undefined
        )?.lifetime_spend_usd_micros ?? 0;
      db.prepare(
        'UPDATE employees SET lifetime_spend_usd_micros = lifetime_spend_usd_micros + ? WHERE id = ?',
      ).run(costMicros, parsed.employee_id);
      employeeLifetimeSpend = { beforeMicros: before, afterMicros: before + costMicros };
    }

    return { taskSpend, projectSpend, employeeLifetimeSpend };
  });

  const { taskSpend, projectSpend, employeeLifetimeSpend } = txn.immediate();
  return { usage: getUsageById(db, id) as Usage, taskSpend, projectSpend, employeeLifetimeSpend };
}

export function getUsageById(db: Database.Database, id: string): Usage | null {
  const row = db.prepare('SELECT * FROM usage WHERE id = ?').get(id);
  return row ? UsageSchema.parse(row) : null;
}

export interface TaskUsageSummary {
  readonly costUsdMicros: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** M5 part 2, §10.3's structured commit message's "Cost:" trailer —
 * `null` when no usage rows exist for this task, so the commit path can
 * omit the line entirely rather than fabricate a `$0.00` (CLAUDE.md's
 * own "do not show $0.00 for an engine that does not report usage"
 * trap, applied here by the same reasoning even though this is a
 * different surface). */
export function getUsageSummaryForTask(
  db: Database.Database,
  taskId: string,
): TaskUsageSummary | null {
  const row = db
    .prepare(
      'SELECT SUM(cost_usd_micros) as cost, SUM(tokens_in) as tokensIn, SUM(tokens_out) as tokensOut FROM usage WHERE task_id = ?',
    )
    .get(taskId) as { cost: number | null; tokensIn: number | null; tokensOut: number | null };
  if (row.cost === null) return null;
  return { costUsdMicros: row.cost, tokensIn: row.tokensIn ?? 0, tokensOut: row.tokensOut ?? 0 };
}

/**
 * §16.1/§24.3: the two daily-scoped budget levels (`budgets.dailyUsd`,
 * `budgets.perEmployeeDailyUsd`) have no denormalised counter — nothing
 * resets one at local midnight, and building a resettable counter for
 * two low-frequency checks (turn completions, not tool calls) would be
 * more machinery than the volume justifies. This is a real, honest
 * ledger query instead: `0`, not `null`, for zero matching rows — this
 * IS a real query result (no usage yet today), not "cost not reported".
 */
export function getUsageSince(
  db: Database.Database,
  sinceIso: string,
  opts: { employeeId?: string } = {},
): number {
  const row = opts.employeeId
    ? (db
        .prepare(
          'SELECT COALESCE(SUM(cost_usd_micros), 0) as total FROM usage WHERE ts >= ? AND employee_id = ?',
        )
        .get(sinceIso, opts.employeeId) as { total: number })
    : (db
        .prepare('SELECT COALESCE(SUM(cost_usd_micros), 0) as total FROM usage WHERE ts >= ?')
        .get(sinceIso) as {
        total: number;
      });
  return row.total;
}

/**
 * AUDIT M0–M2 #4 — the designated writers for the three spend counters,
 * beside the increments above that maintain them.
 *
 * These SET rather than add, which is why they are separate functions
 * rather than a negative increment: their one caller is `reconcile()`'s
 * counter-drift repair, which has computed the correct total from the
 * `usage` ledger and needs to overwrite whatever the column drifted to.
 *
 * They exist because `reconcile.ts` was doing this with three raw
 * `UPDATE`s of its own, giving each of these columns **two owners** —
 * standing rule 6's shape, and invisible to every test of either half.
 * The August audit had already eliminated raw SQL from that file once;
 * `docs/progress/M0-M2.md:478` still records it as clean. It regressed.
 * `tests/unit/rawSqlWritesAreOwned.test.ts` is what stops a third time.
 */
export function setTaskSpend(db: Database.Database, taskId: string, spendMicros: number): void {
  db.prepare('UPDATE tasks SET spend_usd_micros = ? WHERE id = ?').run(spendMicros, taskId);
}

export function setProjectSpend(
  db: Database.Database,
  projectId: string,
  spendMicros: number,
): void {
  db.prepare('UPDATE projects SET spend_usd_micros = ? WHERE id = ?').run(spendMicros, projectId);
}

export function setEmployeeLifetimeSpend(
  db: Database.Database,
  employeeId: string,
  spendMicros: number,
): void {
  db.prepare('UPDATE employees SET lifetime_spend_usd_micros = ? WHERE id = ?').run(
    spendMicros,
    employeeId,
  );
}
