import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { OutboxMessageSchema, type OutboxMessage, type NewOutboxMessageInput } from '../../../shared/models/message';

export function insertOutboxMessage(db: Database.Database, input: NewOutboxMessageInput): OutboxMessage {
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
    idempotency_key: input.idempotency_key,
    from_addr: input.from_addr,
    to_addr: input.to_addr,
    resolved_employee_id: input.resolved_employee_id,
    task_id: input.task_id,
    thread_id: input.thread_id,
    kind: input.kind,
    priority: input.priority,
    subject: input.subject,
    body: input.body,
    status: input.status,
    next_attempt_at: input.next_attempt_at,
    created_at: now,
    updated_at: now,
  });
  return getOutboxMessageById(db, id) as OutboxMessage;
}

export function getOutboxMessageById(db: Database.Database, id: string): OutboxMessage | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  return row ? OutboxMessageSchema.parse(row) : null;
}
