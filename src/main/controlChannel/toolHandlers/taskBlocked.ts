import { resolveOwnedCurrentTask } from '../authorization';
import { setTaskStatus } from '../../db/repositories/tasks';
import { TaskBlockedArgsSchema } from './schemas';
import type { ToolHandler } from './types';

// Same reasoning as taskDone.ts's own set — a task already terminal (or
// already reported done) cannot be "blocked" out from under that; 'blocked'
// itself is deliberately excluded here too (unlike taskDone's set), since
// re-blocking an already-blocked task with a new reason is a legitimate,
// ordinary thing for an agent to do (it tried something else, still can't
// proceed) — not a duplicate report the way a second task_done would be.
const REJECTED_SOURCE_STATUSES = new Set(['review', 'done', 'cancelled', 'failed']);

/**
 * §7.9: bureau_task_blocked — FULL. Task -> blocked; the Director decides
 * whether to answer, reassign, or escalate (M8/M11 — not this session's
 * job). No task_id argument, same design-level closure as bureau_task_done.
 */
export const handleTaskBlocked: ToolHandler = (ctx, rawArgs) => {
  const parsed = TaskBlockedArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_task_blocked: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const resolution = resolveOwnedCurrentTask(ctx.db, ctx.employeeId);
  if (!resolution.ok) {
    if (resolution.reason === 'NO_CURRENT_TASK') {
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: 'bureau_task_blocked: you have no current task assigned.',
      };
    }
    const isMismatch = resolution.reason === 'TASK_OWNERSHIP_MISMATCH';
    ctx.activityLog.logEvent({
      actor: 'system',
      type: 'control.authorization_rejected',
      severity: 'security',
      project_id: isMismatch ? resolution.task.project_id : null,
      task_id: isMismatch ? resolution.task.id : null,
      employee_id: ctx.employeeId,
      checkpoint_id: null,
      payload: { tool: 'bureau_task_blocked', reason: resolution.reason },
    });
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'bureau_task_blocked: your current task could not be resolved or is not yours.',
    };
  }
  const { task } = resolution;

  if (REJECTED_SOURCE_STATUSES.has(task.status)) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_task_blocked: task ${task.display_key} is already '${task.status}' and cannot be blocked.`,
    };
  }

  setTaskStatus(ctx.db, task.id, 'blocked', parsed.data.reason);
  ctx.activityLog.logEvent({
    actor: `employee:${ctx.employeeId}`,
    type: 'task.blocked',
    severity: 'warn',
    project_id: task.project_id,
    task_id: task.id,
    employee_id: ctx.employeeId,
    checkpoint_id: null,
    payload: { reason: parsed.data.reason, tried: parsed.data.tried, needs: parsed.data.needs },
  });

  return { ok: true, data: { taskId: task.id, status: 'blocked' } };
};
