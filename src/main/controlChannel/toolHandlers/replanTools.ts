import { resolveDirectorProject } from '../../director/currentProject';
import { getEmployeeById, setEmployeeStatus } from '../../db/repositories/employees';
import { getTaskById, setTaskStatus } from '../../db/repositories/tasks';
import { amendPlan } from '../../projects/planAmendment';
import { AmendPlanArgsSchema, StopEmployeeArgsSchema } from './schemas';
import type { ToolHandler, ToolHandlerResult } from './types';

/**
 * §7.9's `bureau_amend_plan` — *"Changes an approved plan without a full
 * re-plan"* — and `bureau_stop_employee` — *"Park an employee that is looping
 * or no longer needed"*. Director tools (M11 S3-6a). The amendment's rules
 * are `planAmendment.ts`'s; the project is the turn's.
 */
export const handleAmendPlan: ToolHandler = async (ctx, rawArgs) => {
  const parsed = AmendPlanArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuse('bureau_amend_plan', issues(parsed.error.issues));
  const project = resolveDirectorProject(ctx.db, ctx.supervisorRegistry);
  if (project === null)
    return refuse('bureau_amend_plan', 'this conversation is not about a project.');
  const result = await amendPlan(
    { db: ctx.db, activityLog: ctx.activityLog },
    {
      projectId: project.id,
      directorEmployeeId: ctx.employeeId,
      idempotencyKey: ctx.idempotencyKey,
      amendment: parsed.data,
    },
  );
  if (result.kind === 'refused') return refuse('bureau_amend_plan', result.reason);
  if (result.kind === 'applied') return { ok: true, data: { applied: true } };
  return {
    ok: true,
    data: {
      applied: false,
      checkpointId: result.checkpointId,
      note: 'It changes cost or scope, so the user decides. Nothing changes until they do.',
    },
  };
};

export const handleStopEmployee: ToolHandler = async (ctx, rawArgs) => {
  const parsed = StopEmployeeArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuse('bureau_stop_employee', issues(parsed.error.issues));
  const employee = getEmployeeById(ctx.db, parsed.data.employee_id);
  if (employee === null || employee.archived_at !== null) {
    return refuse('bureau_stop_employee', `there is no employee ${parsed.data.employee_id}.`);
  }
  if (employee.is_director) return refuse('bureau_stop_employee', 'you cannot stop yourself.');

  // Its task, if it holds one, is blocked with the reason, so it is visible
  // and yours to act on (reassign it with a follow-up, or amend the plan).
  const task = employee.current_task_id ? getTaskById(ctx.db, employee.current_task_id) : null;
  if (task !== null && ['assigned', 'running'].includes(task.status)) {
    const reason = `Stopped by the Director: ${parsed.data.reason}`;
    setTaskStatus(ctx.db, task.id, 'blocked', reason);
    ctx.activityLog.logEvent({
      actor: 'director',
      type: 'task.blocked',
      severity: 'info',
      project_id: task.project_id,
      task_id: task.id,
      employee_id: employee.id,
      checkpoint_id: null,
      payload: { reason },
    });
  }
  // Parked the same way a user's pause parks (§14.5), with the reason, so the
  // user's Resume undoes it; a parked employee is not given new work.
  const supervisor = ctx.supervisorRegistry.get(employee.id);
  if (supervisor !== undefined && supervisor.currentState !== 'off') {
    await supervisor.pause('director_stopped');
  } else if (employee.status !== 'parked') {
    // No live process (or one not started): parked in its row, so the loop
    // gives it nothing.
    setEmployeeStatus(ctx.db, employee.id, 'parked');
    ctx.activityLog.logEvent({
      actor: 'director',
      type: 'employee.parked',
      severity: 'info',
      project_id: null,
      task_id: task?.id ?? null,
      employee_id: employee.id,
      checkpoint_id: null,
      payload: { reason: 'director_stopped' },
    });
  }
  return { ok: true, data: { employeeId: employee.id, parked: true } };
};

function issues(list: readonly { path: PropertyKey[]; message: string }[]): string {
  return list.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

function refuse(tool: string, message: string): ToolHandlerResult {
  return { ok: false, code: 'VALIDATION_FAILED', message: `${tool}: ${message}` };
}
