import { resolveDirectorProject } from '../../director/currentProject';
import { getTaskById } from '../../db/repositories/tasks';
import { taskNotReadyReason } from '../../projects/readyTasks';
import { AssignmentRefusedError, claimTask, eligibleEmployees } from '../../projects/assignment';
import { AssignTaskArgsSchema } from './schemas';
import type { ToolHandler, ToolHandlerResult } from './types';

/**
 * §7.9's `bureau_assign_task`: *"Assign or reassign; runs the §8.5
 * eligibility check and refuses with a reason rather than failing
 * silently."* A Director tool (M11 S3-2a).
 *
 * The loop assigns on its own (§26.2: no Director turn per assignment);
 * this is the Director choosing, for a task the loop left waiting or a
 * person it wants on it. It asks exactly what the loop asks —
 * `taskNotReadyReason` and `eligibleEmployees` — and claims through the
 * same `claimTask`, so it can never hand out work the loop would refuse.
 * The task must belong to the turn's project; the project is never an
 * argument (S1-12b).
 */
export const handleAssignTask: ToolHandler = (ctx, rawArgs) => {
  const parsed = AssignTaskArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return refuse(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const project = resolveDirectorProject(ctx.db, ctx.supervisorRegistry);
  if (project === null) {
    return refuse('this conversation is not about a project, so there is no task to assign.');
  }
  const task = getTaskById(ctx.db, parsed.data.task_id);
  if (task === null || task.project_id !== project.id) {
    return refuse(`there is no task ${parsed.data.task_id} in ${project.display_key}.`);
  }
  const notReady = taskNotReadyReason(ctx.db, task.id);
  if (notReady !== null) return refuse(`${task.display_key} cannot be assigned: ${notReady}`);

  // A named employee's eligibility is the claim's to check (one place); with
  // none named, §8.5's key picks the first eligible.
  let employeeId = parsed.data.employee_id;
  if (employeeId === undefined) {
    const { eligible, rejected } = eligibleEmployees(ctx.db, task.id);
    const best = eligible[0];
    if (best === undefined) {
      return refuse(
        `nobody can take ${task.display_key} now: ${rejected.map((r) => r.reason).join(' ')}`,
      );
    }
    employeeId = best.id;
  }

  try {
    const claimed = claimTask(
      { db: ctx.db, activityLog: ctx.activityLog },
      { taskId: task.id, employeeId },
    );
    return { ok: true, data: { taskId: claimed.id, employeeId, status: claimed.status } };
  } catch (err) {
    if (err instanceof AssignmentRefusedError) {
      return refuse(`${task.display_key} cannot be assigned: ${err.message}`);
    }
    throw err;
  }
};

function refuse(message: string): ToolHandlerResult {
  return { ok: false, code: 'VALIDATION_FAILED', message: `bureau_assign_task: ${message}` };
}
