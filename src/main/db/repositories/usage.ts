import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { UsageSchema, type Usage, type NewUsageInput } from '../../../shared/models/usage';

export function insertUsage(db: Database.Database, input: NewUsageInput): Usage {
  const id = newId();
  db.prepare(
    `INSERT INTO usage (id, employee_id, task_id, engine, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost_usd_micros, turn_index, source, ts)
     VALUES (@id, @employee_id, @task_id, @engine, @model, @tokens_in, @tokens_out, @tokens_cache_read, @tokens_cache_write, @cost_usd_micros, @turn_index, @source, @ts)`,
  ).run({
    id,
    employee_id: input.employee_id,
    task_id: input.task_id,
    engine: input.engine,
    model: input.model,
    tokens_in: input.tokens_in,
    tokens_out: input.tokens_out,
    tokens_cache_read: input.tokens_cache_read,
    tokens_cache_write: input.tokens_cache_write,
    cost_usd_micros: input.cost_usd_micros,
    turn_index: input.turn_index,
    source: input.source,
    ts: nowIso(),
  });
  return getUsageById(db, id) as Usage;
}

export function getUsageById(db: Database.Database, id: string): Usage | null {
  const row = db.prepare('SELECT * FROM usage WHERE id = ?').get(id);
  return row ? UsageSchema.parse(row) : null;
}
