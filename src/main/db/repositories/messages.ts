import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import {
  OutboxMessageSchema,
  NewOutboxMessageInputSchema,
  type OutboxMessage,
  type NewOutboxMessageInput,
} from '../../../shared/models/message';

export function insertOutboxMessage(
  db: Database.Database,
  input: NewOutboxMessageInput,
): OutboxMessage {
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
export function getOutboxMessageByIdempotencyKey(
  db: Database.Database,
  idempotencyKey: string,
): OutboxMessage | null {
  const row = db.prepare('SELECT * FROM messages WHERE idempotency_key = ?').get(idempotencyKey);
  return row ? OutboxMessageSchema.parse(row) : null;
}

/**
 * §9.7's hot query — "SELECT pending WHERE next_attempt_at <= now ORDER BY
 * priority DESC, created_at" — backed by `idx_messages_router`.
 *
 * **`next_attempt_at IS NULL` is not a defensive extra; it is most of the
 * table.** `bureau_send_message` and `bureau_ask_director` have inserted
 * rows since M4 leaving `next_attempt_at` at its default `NULL`, which is
 * the truthful value ("no backoff has been applied yet") and which
 * §9.7's literal predicate never matches. Written as the spec's query
 * alone, the router would have ignored every message an agent ever sent
 * and delivered only `answerCheckpoint`'s, which sets the column
 * explicitly. Fixed here rather than by making two producers write a
 * timestamp meaning "immediately".
 */
export function listDeliverableMessages(
  db: Database.Database,
  nowIsoTs: string,
  limit = 50,
): OutboxMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages
        WHERE status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY priority DESC, created_at
        LIMIT ?`,
    )
    .all(nowIsoTs, limit);
  return rows.map((row) => OutboxMessageSchema.parse(row));
}

/**
 * Recorded AFTER `adapter.send()` returns, never before. §9.7: "Exactly-once
 * is not attempted across a process boundary and pretending otherwise
 * causes bugs." Marking first and sending second would lose a message
 * whenever the process died in between; this order redelivers it instead,
 * which is what at-least-once means and what `idempotency_key` exists to
 * make safe.
 */
export function markMessageDelivered(
  db: Database.Database,
  id: string,
  resolvedEmployeeId: string,
  atIso: string,
): void {
  db.prepare(
    `UPDATE messages
        SET status = 'delivered', delivered_at = ?, resolved_employee_id = ?, updated_at = ?
      WHERE id = ?`,
  ).run(atIso, resolvedEmployeeId, atIso, id);
}

/**
 * §9.7: "The employee marks it `consumed` implicitly when its next turn
 * starts — **the supervisor records this, not the agent**." An agent
 * self-reporting consumption is not evidence, so there is deliberately no
 * tool for it; the only caller is `Supervisor`'s own `turn.started`
 * handling.
 */
export function markMessageConsumed(db: Database.Database, id: string, atIso: string): void {
  db.prepare(
    `UPDATE messages SET status = 'consumed', consumed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(atIso, atIso, id);
}

/**
 * A delivery ATTEMPT that threw. Distinct from a hold, which writes
 * nothing at all: a held message has not been attempted, so it must never
 * consume retry budget (see `deliverability.ts`).
 */
export function recordMessageDeliveryFailure(
  db: Database.Database,
  id: string,
  attempts: number,
  nextAttemptAtIso: string,
): void {
  db.prepare(
    `UPDATE messages SET attempts = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
  ).run(attempts, nextAttemptAtIso, nowIso(), id);
}

export function markMessageDeadLettered(db: Database.Database, id: string, attempts: number): void {
  db.prepare(
    `UPDATE messages SET status = 'dead_letter', attempts = ?, updated_at = ? WHERE id = ?`,
  ).run(attempts, nowIso(), id);
}

/**
 * **`consumed_at`'s reader**, and the reason it is not a third write-only
 * column (after `usage.computed_cost_usd_micros` and the old
 * `employees.model`).
 *
 * A row that is `delivered` with `consumed_at IS NULL` means exactly one
 * thing: text reached an adapter and the employee never started another
 * turn with it. Without `consumed_at` that state is indistinguishable
 * from a normal, successful delivery — so there would be no way to tell a
 * message the employee actually received from one that vanished into a
 * process that then died.
 *
 * Bounded on purpose by `deliveredBeforeIso` (the current process's own
 * start): only a delivery made by a PREVIOUS run is requeued, so a message
 * can be requeued at most once per app start rather than looping — and
 * only a previous run's, whose in-memory awaiting-consumption list died
 * with it, so no live `Supervisor` can be about to mark this consumed.
 *
 * `attempts` is deliberately NOT incremented: nothing failed. This is the
 * safe-redelivery half of §9.7's at-least-once, and `idempotency_key` is
 * what makes it safe.
 */
export function listUnconsumedDeliveries(
  db: Database.Database,
  deliveredBeforeIso: string,
): OutboxMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages
        WHERE status = 'delivered' AND consumed_at IS NULL AND delivered_at < ?
        ORDER BY created_at`,
    )
    .all(deliveredBeforeIso);
  return rows.map((row) => OutboxMessageSchema.parse(row));
}

export function requeueMessageForRedelivery(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE messages
        SET status = 'pending', delivered_at = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'delivered' AND consumed_at IS NULL`,
  ).run(nowIso(), id);
}
