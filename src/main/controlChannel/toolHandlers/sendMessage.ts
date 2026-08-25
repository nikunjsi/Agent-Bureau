import { insertOutboxMessage, getOutboxMessageByIdempotencyKey } from '../../db/repositories/messages';
import { getEmployeeById } from '../../db/repositories/employees';
import { SendMessageArgsSchema } from './schemas';
import { insertOrFetchByIdempotencyKey } from './idempotentInsert';
import type { ToolHandler } from './types';

/**
 * §7.9: bureau_send_message — ROW ONLY. `to` names the recipient (another
 * employee or a role) and is exactly what an agent SHOULD be able to name
 * — that is the point of the tool. `from_addr` is always this employee's
 * own id, never agent-suppliable, so nobody can send a message *as*
 * someone else — the ownership question this tool actually has (who sent
 * it, not who it's addressed to) is closed at the design level.
 * `resolved_employee_id` stays null: resolving `to` into a concrete
 * employee id is the router's job (M8), not this handler's.
 */
export const handleSendMessage: ToolHandler = (ctx, rawArgs) => {
  const parsed = SendMessageArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_send_message: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const employee = getEmployeeById(ctx.db, ctx.employeeId);
  const idempotencyKey = `${ctx.employeeId}:${ctx.idempotencyKey}`;

  const message = insertOrFetchByIdempotencyKey(
    () =>
      insertOutboxMessage(ctx.db, {
        idempotency_key: idempotencyKey,
        from_addr: ctx.employeeId,
        to_addr: parsed.data.to,
        task_id: employee?.current_task_id ?? null,
        kind: parsed.data.kind,
        subject: parsed.data.subject,
        body: parsed.data.body,
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
    payload: { messageId: message.id, to: parsed.data.to, kind: parsed.data.kind },
  });

  return { ok: true, data: { messageId: message.id } };
};
