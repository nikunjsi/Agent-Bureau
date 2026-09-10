import type Database from 'better-sqlite3';

/**
 * §11.5.1 / §14.1 — how many employees on the roster cannot report what
 * they cost.
 *
 * ## Why this is its own function
 *
 * It is the **only** place that answers "is this employee metered" from a
 * database row, and it stays the only place (standing rule 6). §14.3's
 * Board and §14.5's Inspector both owe the same disclosure and both should
 * call this rather than re-deriving it — two functions that each decide
 * whether an employee is metered would be individually testable and
 * jointly wrong the first time an engine changed.
 *
 * ## Why it reads columns rather than asking the adapter
 *
 * `EngineCapabilities.usageReporting` is the authoritative statement, and
 * it comes from `adapter.capabilities(probe, mode)` — which needs a
 * constructed adapter and a completed probe. Neither exists for an
 * employee that is merely on the roster, and constructing one per row to
 * paint a title bar would spawn processes to answer a display question.
 *
 * So this is a table, and a table is a second statement of a decision the
 * adapters already make — exactly the shape standing rule 6 warns about.
 * What keeps it honest is that it is not trusted:
 * `tests/integration/cost/unmeteredEngineMode.test.ts` asks **every
 * shipped adapter** what it reports in **every mode** and requires this
 * table to agree exactly. A new engine, or an existing one changing its
 * mind, fails there rather than quietly making §14.1's meter present an
 * incomplete total as a complete one.
 *
 * **An engine not listed here is treated as metered**, and the guard is
 * what makes that safe rather than optimistic: an unlisted engine that
 * reports no usage is precisely the case the guard fails on. Defaulting
 * the other way would mean disclosing "cost not reported" for every future
 * engine that reports cost perfectly well, forever, until someone noticed.
 */
type UnmeteredModes = 'all' | readonly string[];

const UNMETERED_BY_ENGINE: Readonly<Record<string, UnmeteredModes>> = {
  /** §7.7.1 — "unmeterable, permanently". `GenericPtyAdapter.capabilities`
   * returns `usageReporting: false` without consulting the mode at all,
   * because a pty carries no usage signal in any configuration. */
  'generic-pty': 'all',
  /** Structured mode reports real usage; the pty branch cannot. Today that
   * branch is unreachable in production (§7.7.1 rejects `mode: 'pty'` for
   * claude-code at role load), and it is listed anyway — the guard checks
   * what the adapter says, not what a role file currently allows. */
  'claude-code': ['pty'],
};

/**
 * `engineMode` is `employees.engine_mode`, which is nullable: null means
 * "the engine's own default", and no shipped engine's default is unmetered
 * except `generic-pty`, which is caught by its `'all'` rule.
 */
export function isUnmeteredEngine(engine: string, engineMode: string | null): boolean {
  const rule = UNMETERED_BY_ENGINE[engine];
  if (rule === undefined) return false;
  if (rule === 'all') return true;
  return engineMode !== null && rule.includes(engineMode);
}

/**
 * The count §14.1's meter discloses. Every employee on the roster, no time
 * filter — see `CostSummarySchema.unmeteredEmployeeCount` for why "running
 * today" is not knowable for precisely these employees, and why a superset
 * is the fail-closed direction.
 *
 * Grouped in SQL and filtered in TypeScript so the decision stays in
 * `isUnmeteredEngine` alone. Encoding the table into a WHERE clause would
 * be the same rule written twice, in two languages, free to disagree; the
 * grouping keeps what crosses the boundary to one row per distinct
 * engine/mode pair rather than one per employee.
 */
export function countUnmeteredEmployees(db: Database.Database): number {
  const rows = db
    .prepare(
      'SELECT engine, engine_mode, COUNT(*) as n FROM employees GROUP BY engine, engine_mode',
    )
    .all() as Array<{ engine: string; engine_mode: string | null; n: number }>;
  return rows
    .filter((row) => isUnmeteredEngine(row.engine, row.engine_mode))
    .reduce((total, row) => total + row.n, 0);
}
