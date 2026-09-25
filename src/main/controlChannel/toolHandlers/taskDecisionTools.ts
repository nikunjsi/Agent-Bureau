import { resolveDirectorProject } from '../../director/currentProject';
import { getTaskById } from '../../db/repositories/tasks';
import { acceptTask, rejectTask } from '../../projects/taskDecision';
import { AcceptTaskArgsSchema, RejectTaskArgsSchema } from './schemas';
import type { ToolHandler, ToolHandlerContext, ToolHandlerResult } from './types';

/**
 * §7.9's `bureau_accept_task` — *"Completion evaluation passed → merge and
 * mark done (§8.5.1)"* — and `bureau_reject_task` — *"Criteria not met →
 * follow-up task or blocked"*. Director tools (M11 S3-4b). The task must be
 * the turn's project's; the decisions themselves are `taskDecision.ts`'s.
 */
export const handleAcceptTask: ToolHandler = async (ctx, rawArgs) => {
  const parsed = AcceptTaskArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuse('bureau_accept_task', issues(parsed.error.issues));
  const scoped = taskInTurnProject(ctx, parsed.data.task_id);
  if (!scoped.ok) return refuse('bureau_accept_task', scoped.reason);
  const result = await acceptTask(
    { db: ctx.db, activityLog: ctx.activityLog },
    {
      taskId: scoped.taskId,
      rationale: parsed.data.rationale,
      notVerified: parsed.data.not_verified,
      by: 'director',
    },
  );
  if (result.kind === 'refused') return refuse('bureau_accept_task', result.reason);
  if (result.kind === 'conflict') {
    return {
      ok: true,
      data: {
        merged: false,
        conflictCheckpointId: result.checkpointId,
        note: 'It conflicts with work already merged into the phase. The user has a checkpoint; the task is blocked until it is resolved.',
      },
    };
  }
  return {
    ok: true,
    data: { merged: true, mergedInto: result.mergedInto, mergeCommit: result.mergeCommit },
  };
};

export const handleRejectTask: ToolHandler = (ctx, rawArgs) => {
  const parsed = RejectTaskArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuse('bureau_reject_task', issues(parsed.error.issues));
  const scoped = taskInTurnProject(ctx, parsed.data.task_id);
  if (!scoped.ok) return refuse('bureau_reject_task', scoped.reason);
  const result = rejectTask(
    { db: ctx.db, activityLog: ctx.activityLog },
    {
      taskId: scoped.taskId,
      rationale: parsed.data.rationale,
      ...(parsed.data.follow_up === undefined ? {} : { followUp: parsed.data.follow_up }),
    },
  );
  if (result.kind === 'refused') return refuse('bureau_reject_task', result.reason);
  return { ok: true, data: result };
};

/** The task, when it is the turn's project's; else the refusal. */
function taskInTurnProject(
  ctx: ToolHandlerContext,
  taskId: string,
): { ok: true; taskId: string } | { ok: false; reason: string } {
  const project = resolveDirectorProject(ctx.db, ctx.supervisorRegistry);
  if (project === null) return { ok: false, reason: 'this conversation is not about a project.' };
  const task = getTaskById(ctx.db, taskId);
  if (task === null || task.project_id !== project.id) {
    return { ok: false, reason: `there is no task ${taskId} in ${project.display_key}.` };
  }
  return { ok: true, taskId: task.id };
}

function issues(list: readonly { path: PropertyKey[]; message: string }[]): string {
  return list.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

function refuse(tool: string, message: string): ToolHandlerResult {
  return { ok: false, code: 'VALIDATION_FAILED', message: `${tool}: ${message}` };
}
