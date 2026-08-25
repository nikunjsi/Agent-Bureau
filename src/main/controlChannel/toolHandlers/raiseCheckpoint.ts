import { insertCheckpoint } from '../../db/repositories/checkpoints';
import { getEmployeeById } from '../../db/repositories/employees';
import { getTaskById } from '../../db/repositories/tasks';
import { RaiseCheckpointArgsSchema } from './schemas';
import type { ToolHandler } from './types';

/**
 * §7.9: bureau_raise_checkpoint — ROW ONLY (the UI is M8's job). §9's
 * "reject any option lacking a consequence" is enforced by
 * RaiseCheckpointArgsSchema itself (schemas.ts: `consequence: z.string().
 * min(1)`, required, not optional) — Zod's own safeParse below already
 * rejects a malformed call before this handler does anything else, so
 * there is exactly one place that rule lives, not a second hand-rolled
 * check duplicating it.
 *
 * employee_id/task_id/project_id are all derived from the caller's own
 * current row, never agent-supplied — a checkpoint attributed to the
 * wrong employee would misattribute a real decision.
 */
export const handleRaiseCheckpoint: ToolHandler = (ctx, rawArgs) => {
  const parsed = RaiseCheckpointArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_raise_checkpoint: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const employee = getEmployeeById(ctx.db, ctx.employeeId);
  const task = employee?.current_task_id ? getTaskById(ctx.db, employee.current_task_id) : null;

  const checkpoint = insertCheckpoint(ctx.db, {
    project_id: task?.project_id ?? null,
    task_id: task?.id ?? null,
    employee_id: ctx.employeeId,
    type: parsed.data.type,
    urgency: parsed.data.urgency,
    tool_call_id: ctx.idempotencyKey,
    tool_name: 'bureau_raise_checkpoint',
    title: parsed.data.title,
    context: parsed.data.context,
    options: parsed.data.options,
    preview: parsed.data.preview ?? null,
  });

  ctx.activityLog.logEvent({
    actor: `employee:${ctx.employeeId}`,
    type: 'checkpoint.raised',
    severity: 'info',
    project_id: checkpoint.project_id,
    task_id: checkpoint.task_id,
    employee_id: ctx.employeeId,
    checkpoint_id: checkpoint.id,
    payload: { type: parsed.data.type, urgency: parsed.data.urgency, title: parsed.data.title },
  });

  return { ok: true, data: { checkpointId: checkpoint.id } };
};
