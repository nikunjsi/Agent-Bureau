import { insertOutboxMessage, getOutboxMessageByIdempotencyKey } from '../../db/repositories/messages';
import { getEmployeeById } from '../../db/repositories/employees';
import { AskDirectorArgsSchema, type MessageUrgency } from './schemas';
import { insertOrFetchByIdempotencyKey } from './idempotentInsert';
import type { ToolHandler } from './types';

/** §7.9's own text doesn't give urgency numeric weight; a small, explicit
 * mapping into the outbox's real `priority` column (higher = handled
 * first, per idx_messages_router's own `priority DESC`) rather than
 * leaving urgency as unused metadata. */
const URGENCY_TO_PRIORITY: Record<MessageUrgency, number> = { low: 20, normal: 50, high: 80 };

/**
 * §7.9: bureau_ask_director — ROW ONLY. Creates a real `messages` row
 * addressed to 'director'; the router that actually delivers it is M8's
 * job. from_addr is always this employee's own id — never agent-suppliable
 * — closing any "ask on someone else's behalf" question at the design
 * level, same principle as authorization.ts.
 */
export const handleAskDirector: ToolHandler = (ctx, rawArgs) => {
  const parsed = AskDirectorArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_ask_director: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const employee = getEmployeeById(ctx.db, ctx.employeeId);
  const idempotencyKey = `${ctx.employeeId}:${ctx.idempotencyKey}`;

  const message = insertOrFetchByIdempotencyKey(
    () =>
      insertOutboxMessage(ctx.db, {
        idempotency_key: idempotencyKey,
        from_addr: ctx.employeeId,
        to_addr: 'director',
        task_id: employee?.current_task_id ?? null,
        kind: 'question',
        priority: URGENCY_TO_PRIORITY[parsed.data.urgency],
        subject: parsed.data.question.slice(0, 120),
        body: [parsed.data.question, parsed.data.context ? `\n\nContext:\n${parsed.data.context}` : ''].join(''),
      }),
    () => getOutboxMessageByIdempotencyKey(ctx.db, idempotencyKey),
  );

  ctx.activityLog.logEvent({
    actor: `employee:${ctx.employeeId}`,
    type: 'message.sent',
    severity: 'info',
    project_id: null,
    task_id: message.task_id,
    employee_id: ctx.employeeId,
    checkpoint_id: null,
    payload: { messageId: message.id, to: 'director', kind: 'question', urgency: parsed.data.urgency },
  });

  return { ok: true, data: { messageId: message.id } };
};
