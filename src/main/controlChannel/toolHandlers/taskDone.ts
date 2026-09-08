import { resolveOwnedCurrentTask } from '../authorization';
import { completeTask } from '../../db/repositories/tasks';
import { insertArtifact } from '../../db/repositories/artifacts';
import { TaskDoneArgsSchema } from './schemas';
import type { ToolHandlerResult } from './types';
import type { ToolHandler } from './types';

/** Task states bureau_task_done may legally act on — everything else is
 * rejected with a clear, agent-readable reason rather than silently
 * applied. 'review'/'done'/'cancelled'/'failed' are all terminal-or-
 * already-reported from this tool's own point of view: a second
 * bureau_task_done for the same task (the "twice/retry" case §7.9/M4
 * session 2 asks about — first wins if the idempotency key differs, since
 * IdempotencyCache only catches an *identical* key) must not silently
 * re-apply. 'blocked' is deliberately allowed: it is the exact state
 * handleFinished's pessimistic ended_without_report branch leaves a task
 * in when the report was still in flight when 'finished' fired — the
 * report is allowed to correct it, per supervisor.ts's own documented
 * race resolution ("task_done wins whenever it lands"). */
const REJECTED_SOURCE_STATUSES = new Set(['review', 'done', 'cancelled', 'failed']);

/**
 * §7.9: bureau_task_done — FULL, "the only way a task completes." No
 * task_id argument (§7.9's own table never lists one; see
 * authorization.ts's doc comment for why) — the task is always the
 * caller's own current one, resolved and ownership-checked by
 * resolveOwnedCurrentTask.
 *
 * artifacts[] writes real `artifacts` rows now, not deferred: the table
 * and repository already exist in full from M1 with a trivial shape
 * (kind/title/path/content/mime) — not writing them would silently drop
 * data the agent explicitly reported producing, which is exactly the kind
 * of gap "no claim without a test" exists to catch. Deferring would only
 * be justified by a missing subsystem; none is missing here.
 */
export const handleTaskDone: ToolHandler = (ctx, rawArgs) => {
  const parsed = TaskDoneArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_task_done: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const resolution = resolveOwnedCurrentTask(ctx.db, ctx.employeeId);
  const authFailure = authorizationFailureResponse(resolution, ctx);
  if (authFailure) return authFailure;
  // authorizationFailureResponse returning null means resolution.ok is
  // true — TypeScript can't see that narrowing through the helper, so
  // this re-check is for the type system, not new logic.
  if (!resolution.ok) throw new Error('unreachable');
  const { task } = resolution;

  if (REJECTED_SOURCE_STATUSES.has(task.status)) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_task_done: task ${task.display_key} is already '${task.status}' — it cannot be completed again. If this was a retry, it should have reused the original idempotency key.`,
    };
  }

  completeTask(ctx.db, task.id, parsed.data.summary);
  for (const artifact of parsed.data.artifacts) {
    insertArtifact(ctx.db, {
      task_id: task.id,
      employee_id: ctx.employeeId,
      kind: artifact.kind,
      title: artifact.title,
      path: artifact.path,
      content: artifact.content,
      mime: artifact.mime,
    });
  }

  ctx.activityLog.logEvent({
    actor: `employee:${ctx.employeeId}`,
    type: 'task.submitted_for_review',
    severity: 'info',
    project_id: task.project_id,
    task_id: task.id,
    employee_id: ctx.employeeId,
    checkpoint_id: null,
    payload: {
      summary: parsed.data.summary,
      verified: parsed.data.verified,
      not_verified: parsed.data.not_verified,
      artifactCount: parsed.data.artifacts.length,
    },
  });

  // THE BLOCKER fix (M4 session 2): tell this employee's supervisor a
  // report landed, so handleFinished() takes the 'review' branch instead
  // of ended_without_report. Missing supervisor (no live instance
  // registered) is logged, not thrown — the task's own DB write above is
  // the durable, important side effect and must not be undone by a
  // registry lookup miss; see supervisorRegistry.ts for why this
  // shouldn't normally happen.
  const supervisor = ctx.supervisorRegistry.get(ctx.employeeId);
  if (supervisor) {
    supervisor.noteTaskDone(task.id);
  } else {
    // Not a security concern (nothing was denied or crossed) — just an
    // unexpected internal-consistency gap worth a warn-level record: the
    // task's own DB write above already happened and stands regardless.
    ctx.activityLog.logEvent({
      actor: 'system',
      type: 'control.supervisor_not_found',
      severity: 'warn',
      project_id: task.project_id,
      task_id: task.id,
      employee_id: ctx.employeeId,
      checkpoint_id: null,
      payload: {
        reason:
          'bureau_task_done completed but no live Supervisor was registered for this employee — the task row is still correct',
      },
    });
  }

  return { ok: true, data: { taskId: task.id, status: 'review' } };
};

function authorizationFailureResponse(
  resolution: ReturnType<typeof resolveOwnedCurrentTask>,
  ctx: Parameters<ToolHandler>[0],
): ToolHandlerResult | null {
  if (resolution.ok) return null;

  if (resolution.reason === 'NO_CURRENT_TASK') {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'bureau_task_done: you have no current task assigned.',
    };
  }

  // TASK_OWNERSHIP_MISMATCH checked first (a positive check on the one
  // variant that carries `task`) so TypeScript narrows the object shape
  // reliably — narrowing by elimination across a reason union nested
  // inside one variant of a larger union is not something every TS
  // version proves exhaustively.
  if (resolution.reason === 'TASK_OWNERSHIP_MISMATCH') {
    // The real "crossed task id" case: the authenticated employee's
    // current_task_id points at a task actually assigned to someone
    // else. Rejected AND logged as security, per the explicit ask.
    ctx.activityLog.logEvent({
      actor: 'system',
      type: 'control.authorization_rejected',
      severity: 'security',
      project_id: resolution.task.project_id,
      task_id: resolution.task.id,
      employee_id: ctx.employeeId,
      checkpoint_id: null,
      payload: {
        tool: 'bureau_task_done',
        reason: 'TASK_OWNERSHIP_MISMATCH',
        actualAssignee: resolution.task.assignee_employee_id,
      },
    });
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message:
        'bureau_task_done: you are not the assignee of your own current task — this call was rejected.',
    };
  }

  // EMPLOYEE_NOT_FOUND | TASK_NOT_FOUND — should be impossible (see
  // authorization.ts's own comments), logged as security defensively.
  ctx.activityLog.logEvent({
    actor: 'system',
    type: 'control.authorization_rejected',
    severity: 'security',
    project_id: null,
    task_id: null,
    employee_id: ctx.employeeId,
    checkpoint_id: null,
    payload: { tool: 'bureau_task_done', reason: resolution.reason },
  });
  return {
    ok: false,
    code: 'VALIDATION_FAILED',
    message: 'bureau_task_done: your current task could not be resolved.',
  };
}
