import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  PlanSchema,
  NewPlanInputSchema,
  type Plan,
  type NewPlanInput,
} from '../../../shared/models/plan';

export function insertPlan(db: Database.Database, input: NewPlanInput): Plan {
  const parsed = NewPlanInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO plans (id, project_id, brief_id, version, content, estimated_cost_usd_micros, status, approved_at, created_at, updated_at)
     VALUES (@id, @project_id, @brief_id, @version, @content, @estimated_cost_usd_micros, @status, @approved_at, @created_at, @updated_at)`,
  ).run({
    id,
    project_id: parsed.project_id,
    brief_id: parsed.brief_id,
    version: parsed.version,
    content: toJsonColumn(parsed.content),
    estimated_cost_usd_micros: parsed.estimated_cost_usd_micros,
    status: parsed.status,
    approved_at: parsed.approved_at,
    created_at: now,
    updated_at: now,
  });
  return getPlanById(db, id) as Plan;
}

export function getPlanById(db: Database.Database, id: string): Plan | null {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  return row ? PlanSchema.parse(row) : null;
}

/**
 * §8.4's approval, and the twin of `approveBrief` — same compare-and-set,
 * same reasons. Two windows can both press Approve; a plan superseded by a
 * newer version must not be approvable, or work would be authorised
 * against a plan the user has replaced.
 */
export function approvePlan(db: Database.Database, id: string): boolean {
  const at = nowIso();
  const result = db
    .prepare(
      `UPDATE plans SET status = 'approved', approved_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('draft','awaiting_approval')`,
    )
    .run(at, at, id);
  return result.changes === 1;
}
