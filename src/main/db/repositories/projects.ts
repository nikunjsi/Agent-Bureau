import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  ProjectSchema,
  NewProjectInputSchema,
  type Project,
  type NewProjectInput,
} from '../../../shared/models/project';
import { nextCounterValue, formatDisplayKey } from './counters';

/**
 * Must be called from inside a `db.transaction` (or SQLite's implicit
 * autocommit transaction is fine too, since better-sqlite3's `.run` is
 * already atomic per-statement — the requirement is specifically "counter
 * increment and row insert in the same transaction", §5.1.2) so the
 * display key and the row appear together or not at all.
 *
 * Input is validated **before** the transaction opens (AUDIT finding #1) —
 * an invalid input must never consume a counter value or write a row.
 */
export function insertProject(db: Database.Database, input: NewProjectInput): Project {
  const parsed = NewProjectInputSchema.parse(input);

  const insertTxn = db.transaction(() => {
    const counterValue = nextCounterValue(db, 'project');
    const displayKey = formatDisplayKey('P', counterValue, 3);
    const id = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO projects (
         id, display_key, name, path, repo_initialised, base_ref, protected_refs,
         kind, stage, brief_id, plan_id, budget_usd_micros, spend_usd_micros, created_at, updated_at
       ) VALUES (
         @id, @display_key, @name, @path, @repo_initialised, @base_ref, @protected_refs,
         @kind, @stage, @brief_id, @plan_id, @budget_usd_micros, @spend_usd_micros, @created_at, @updated_at
       )`,
    ).run({
      id,
      display_key: displayKey,
      name: parsed.name,
      path: parsed.path,
      repo_initialised: parsed.repo_initialised ? 1 : 0,
      base_ref: parsed.base_ref,
      protected_refs: toJsonColumn(parsed.protected_refs),
      kind: parsed.kind,
      stage: parsed.stage,
      brief_id: parsed.brief_id,
      plan_id: parsed.plan_id,
      budget_usd_micros: parsed.budget_usd_micros,
      spend_usd_micros: parsed.spend_usd_micros,
      created_at: now,
      updated_at: now,
    });
    return id;
  });

  const id = insertTxn.immediate();
  return getProjectById(db, id) as Project;
}

export function getProjectById(db: Database.Database, id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? ProjectSchema.parse(row) : null;
}

/** §4.4's git-worktree reconciliation runs per-project, only against
 * projects whose workspace has actually been registered — a project
 * with no repo has no `worktrees` to reconcile against. */
export function listRepoInitialisedProjects(db: Database.Database): Project[] {
  const rows = db.prepare('SELECT * FROM projects WHERE repo_initialised = 1').all();
  return rows.map((row) => ProjectSchema.parse(row));
}

export function setProjectBriefAndPlan(
  db: Database.Database,
  projectId: string,
  briefId: string | null,
  planId: string | null,
): void {
  db.prepare('UPDATE projects SET brief_id = ?, plan_id = ? WHERE id = ?').run(
    briefId,
    planId,
    projectId,
  );
}

/** §28 M5 item 1: set once workspace registration (`git init` if needed,
 * repo-level config — `src/main/workspace/gitInit.ts`) has actually run
 * against `projects.path`. */
export function setProjectRepoInitialised(
  db: Database.Database,
  projectId: string,
  initialised: boolean,
): void {
  db.prepare('UPDATE projects SET repo_initialised = ? WHERE id = ?').run(
    initialised ? 1 : 0,
    projectId,
  );
}

/** M6 session 3 — `projects.setBudget`'s own write, mirroring
 * `setProjectRepoInitialised`'s shape exactly. This is the per-project
 * override of the four budget levels session 2 built —
 * `budgetEnforcement.ts` already reads this same column, falling back to
 * the global `budgets.projectUsd` setting when it's `null`. */
export function setProjectBudget(
  db: Database.Database,
  projectId: string,
  budgetUsdMicros: number,
): void {
  db.prepare('UPDATE projects SET budget_usd_micros = ? WHERE id = ?').run(
    budgetUsdMicros,
    projectId,
  );
}

/** M11 S2-1b: §8's lifecycle stage. Only `setProjectStage`
 *  (`src/main/projects/projectStage.ts`) calls this, after validating the
 *  move against §8's table and A.3. */
export function setProjectStageColumn(
  db: Database.Database,
  projectId: string,
  stage: Project['stage'],
): void {
  db.prepare('UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?').run(
    stage,
    nowIso(),
    projectId,
  );
}

/** M11 S2-3a: the approved brief's `kind` (§8.1 decides it at intake) and
 *  the brief the project now runs on. Only `approveBriefWithDeliverables`
 *  calls this, inside the approval's transaction. */
export function setProjectApprovedBrief(
  db: Database.Database,
  projectId: string,
  briefId: string,
  kind: Project['kind'],
): void {
  db.prepare('UPDATE projects SET brief_id = ?, kind = ?, updated_at = ? WHERE id = ?').run(
    briefId,
    kind,
    nowIso(),
    projectId,
  );
}
