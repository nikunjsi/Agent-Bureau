import { GetProjectStateArgsSchema } from './schemas';
import { resolveDirectorProject } from '../../director/currentProject';
import type { ToolHandler } from './types';

/**
 * §7.9's `bureau_get_project_state`: *"Tasks, statuses, spend, blockers —
 * cheaper and more reliable than holding it in context."* A Director tool
 * (M11 row S1-12b).
 *
 * The point of the tool is the second half of that sentence. The Director
 * runs over many turns and its context is assembled fresh each time; a
 * state it remembered from six turns ago is a state that has since moved.
 * So this reads the database, every time, and nothing here is cached.
 *
 * **The project is not an argument.** It is the one the Director's
 * conversation is about (`resolveDirectorProject`, the same answer
 * `${project}` gets) — an id an agent could pass would be an id it could
 * get wrong, or use to read a project it is not on.
 *
 * Money is integer micro-dollars all the way out (invariant #12); the
 * caller formats. A task whose engine reported no usage has `null` spend,
 * not `0` — "not reported" and "free" are different facts (CLAUDE.md).
 */

interface TaskRow {
  id: string;
  display_key: string;
  title: string;
  status: string;
  status_reason: string | null;
  assignee_employee_id: string | null;
  phase_id: string | null;
  spend_usd_micros: number | null;
  estimated_cost_usd_micros: number | null;
}

export const handleGetProjectState: ToolHandler = (ctx, rawArgs) => {
  const parsed = GetProjectStateArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_get_project_state: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    };
  }

  const project = resolveDirectorProject(ctx.db, ctx.supervisorRegistry);
  if (project === null) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message:
        'bureau_get_project_state: there is no project on this conversation yet, so there is ' +
        'no project state to report. Create one from the conversation first.',
    };
  }

  const tasks = ctx.db
    .prepare(
      `SELECT id, display_key, title, status, status_reason, assignee_employee_id, phase_id,
              spend_usd_micros, estimated_cost_usd_micros
         FROM tasks WHERE project_id = ? ORDER BY created_at`,
    )
    .all(project.id) as TaskRow[];

  const openCheckpoints = ctx.db
    .prepare(
      `SELECT id, type, title, urgency FROM checkpoints
        WHERE project_id = ? AND status = 'pending' ORDER BY created_at`,
    )
    .all(project.id) as Array<{ id: string; type: string; title: string; urgency: string }>;

  return {
    ok: true,
    data: {
      project: {
        id: project.id,
        displayKey: project.display_key,
        name: project.name,
        stage: project.stage,
        kind: project.kind,
        budgetUsdMicros: project.budget_usd_micros,
        spendUsdMicros: project.spend_usd_micros,
      },
      tasks: tasks.map((task) => ({
        id: task.id,
        displayKey: task.display_key,
        title: task.title,
        status: task.status,
        assigneeEmployeeId: task.assignee_employee_id,
        phaseId: task.phase_id,
        spendUsdMicros: task.spend_usd_micros,
        estimatedCostUsdMicros: task.estimated_cost_usd_micros,
      })),
      // The blockers are a view of the same rows, not a second source:
      // "what is stuck" is the question a Director asks most often, and
      // making it read a status enum out of a list is how it gets missed.
      blockers: tasks
        .filter((task) => task.status === 'blocked')
        .map((task) => ({
          taskId: task.id,
          displayKey: task.display_key,
          title: task.title,
          reason: task.status_reason,
        })),
      openCheckpoints,
    },
  };
};
