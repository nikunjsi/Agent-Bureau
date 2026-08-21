import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { PhaseSchema, NewPhaseInputSchema, type Phase, type NewPhaseInput } from '../../../shared/models/phase';

export function insertPhase(db: Database.Database, input: NewPhaseInput): Phase {
  const parsed = NewPhaseInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO phases (id, plan_id, ordinal, name, goal, review_required, status, created_at, updated_at)
     VALUES (@id, @plan_id, @ordinal, @name, @goal, @review_required, @status, @created_at, @updated_at)`,
  ).run({
    id,
    plan_id: parsed.plan_id,
    ordinal: parsed.ordinal,
    name: parsed.name,
    goal: parsed.goal,
    review_required: parsed.review_required ? 1 : 0,
    status: parsed.status,
    created_at: now,
    updated_at: now,
  });
  return getPhaseById(db, id) as Phase;
}

export function getPhaseById(db: Database.Database, id: string): Phase | null {
  const row = db.prepare('SELECT * FROM phases WHERE id = ?').get(id);
  return row ? PhaseSchema.parse(row) : null;
}
