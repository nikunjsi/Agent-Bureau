import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { ProjectSchema, type Project, type NewProjectInput } from '../../../shared/models/project';
import { nextCounterValue, formatDisplayKey } from './counters';

/**
 * Must be called from inside a `db.transaction` (or SQLite's implicit
 * autocommit transaction is fine too, since better-sqlite3's `.run` is
 * already atomic per-statement — the requirement is specifically "counter
 * increment and row insert in the same transaction", §5.1.2) so the
 * display key and the row appear together or not at all.
 */
export function insertProject(db: Database.Database, input: NewProjectInput): Project {
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
      name: input.name,
      path: input.path,
      repo_initialised: input.repo_initialised ? 1 : 0,
      base_ref: input.base_ref,
      protected_refs: toJsonColumn(input.protected_refs),
      kind: input.kind,
      stage: input.stage,
      brief_id: input.brief_id,
      plan_id: input.plan_id,
      budget_usd_micros: input.budget_usd_micros,
      spend_usd_micros: input.spend_usd_micros,
      created_at: now,
      updated_at: now,
    });
    return id;
  });

  const id = insertTxn();
  return getProjectById(db, id) as Project;
}

export function getProjectById(db: Database.Database, id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? ProjectSchema.parse(row) : null;
}

export function setProjectBriefAndPlan(
  db: Database.Database,
  projectId: string,
  briefId: string | null,
  planId: string | null,
): void {
  db.prepare('UPDATE projects SET brief_id = ?, plan_id = ? WHERE id = ?').run(briefId, planId, projectId);
}
