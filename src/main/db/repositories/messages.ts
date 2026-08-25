import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { OutboxMessageSchema, NewOutboxMessageInputSchema, type OutboxMessage, type NewOutboxMessageInput } from '../../../shared/models/message';

export function insertOutboxMessage(db: Database.Database, input: NewOutboxMessageInput): OutboxMessage {
  const parsed = NewOutboxMessageInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO messages (
       id, idempotency_key, from_addr, to_addr, resolved_employee_id, task_id, thread_id,
       kind, priority, subject, body, status, attempts, next_attempt_at, delivered_at, consumed_at, created_at, updated_at
     ) VALUES (
       @id, @idempotency_key, @from_addr, @to_addr, @resolved_employee_id, @task_id, @thread_id,
       @kind, @priority, @subject, @body, @status, 0, @next_attempt_at, NULL, NULL, @created_at, @updated_at
     )`,
  ).run({
    id,
    idempotency_key: parsed.idempotency_key,
    from_addr: parsed.from_addr,
    to_addr: parsed.to_addr,
    resolved_employee_id: parsed.resolved_employee_id,
    task_id: parsed.task_id,
    thread_id: parsed.thread_id,
    kind: parsed.kind,
    priority: parsed.priority,
    subject: parsed.subject,
    body: parsed.body,
    status: parsed.status,
    next_attempt_at: parsed.next_attempt_at,
    created_at: now,
    updated_at: now,
  });
  return getOutboxMessageById(db, id) as OutboxMessage;
}

export function getOutboxMessageById(db: Database.Database, id: string): OutboxMessage | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  return row ? OutboxMessageSchema.parse(row) : null;
}

/** The messages.idempotency_key column's own UNIQUE constraint is the
 * second line of defense a retried tool call can hit if the in-memory
 * IdempotencyCache (M4 session 1) didn't catch it — e.g. the Core
 * restarted between the original call and a retry. Callers use this to
 * fetch the row a UNIQUE-constraint-violating insert collided with,
 * rather than surfacing the raw SQLite error to an agent. */
export function getOutboxMessageByIdempotencyKey(db: Database.Database, idempotencyKey: string): OutboxMessage | null {
  const row = db.prepare('SELECT * FROM messages WHERE idempotency_key = ?').get(idempotencyKey);
  return row ? OutboxMessageSchema.parse(row) : null;
}
