import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { UsageSchema, NewUsageInputSchema, type Usage, type NewUsageInput } from '../../../shared/models/usage';

export function insertUsage(db: Database.Database, input: NewUsageInput): Usage {
  const parsed = NewUsageInputSchema.parse(input);
  const id = newId();
  db.prepare(
    `INSERT INTO usage (id, employee_id, task_id, engine, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost_usd_micros, turn_index, source, ts)
     VALUES (@id, @employee_id, @task_id, @engine, @model, @tokens_in, @tokens_out, @tokens_cache_read, @tokens_cache_write, @cost_usd_micros, @turn_index, @source, @ts)`,
  ).run({
    id,
    employee_id: parsed.employee_id,
    task_id: parsed.task_id,
    engine: parsed.engine,
    model: parsed.model,
    tokens_in: parsed.tokens_in,
    tokens_out: parsed.tokens_out,
    tokens_cache_read: parsed.tokens_cache_read,
    tokens_cache_write: parsed.tokens_cache_write,
    cost_usd_micros: parsed.cost_usd_micros,
    turn_index: parsed.turn_index,
    source: parsed.source,
    ts: nowIso(),
  });
  return getUsageById(db, id) as Usage;
}

export function getUsageById(db: Database.Database, id: string): Usage | null {
  const row = db.prepare('SELECT * FROM usage WHERE id = ?').get(id);
  return row ? UsageSchema.parse(row) : null;
}
