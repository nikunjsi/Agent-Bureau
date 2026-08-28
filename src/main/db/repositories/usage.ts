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
export function getUsageSummaryForTask(db: Database.Database, taskId: string): TaskUsageSummary | null {
  const row = db
    .prepare('SELECT SUM(cost_usd_micros) as cost, SUM(tokens_in) as tokensIn, SUM(tokens_out) as tokensOut FROM usage WHERE task_id = ?')
    .get(taskId) as { cost: number | null; tokensIn: number | null; tokensOut: number | null };
  if (row.cost === null) return null;
  return { costUsdMicros: row.cost, tokensIn: row.tokensIn ?? 0, tokensOut: row.tokensOut ?? 0 };
}
