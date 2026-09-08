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
