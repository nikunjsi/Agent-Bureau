import { approvePlan, getPlanById } from '../../db/repositories/plans';
import { ipcError, ipcOk } from '../../../shared/ipc/envelope';
import { Plan as PlanSchemas } from '../../../shared/ipc/schemas/plan';
import { stub, type Handler } from './types';

/**
 * §8.4's approval, the twin of `brief.approve` and real for the same
 * reasons — a row state change against a status enum and an `approved_at`
 * that already model it, with `project.plan_approved` already in §5.2.
 *
 * **There is no `plan.saveEdit`, deliberately.** §17.1's method surface
 * does not have one and `plans` has no `markdown` column — a plan is
 * phases, tasks and dependencies, not prose. So §14.2's `Edit` on a plan
 * card is not a text editor: it opens the composer with the plan as
 * context, which is `chat.send`. That is the honest reading of "Edit" for
 * a structured document whose structure only the Director can rebuild.
 */
export const planHandlers: Record<string, Handler> = {
  get: (input, ctx) => {
    const { projectId } = PlanSchemas.get.input.parse(input);
    const row = ctx.db
      .prepare('SELECT id FROM plans WHERE project_id = ? ORDER BY version DESC LIMIT 1')
      .get(projectId) as { id: string } | undefined;
    return ipcOk({ item: row ? getPlanById(ctx.db, row.id) : null });
  },

  approve: (input, ctx) => {
    const { id } = PlanSchemas.approve.input.parse(input);
    const plan = getPlanById(ctx.db, id);
    if (plan === null) return ipcError('NOT_FOUND', `No plan with id "${id}".`);

    if (!approvePlan(ctx.db, id)) {
      return plan.status === 'approved'
        ? ipcOk(PlanSchemas.approve.output.parse({ ok: true }))
        : ipcError(
            'VALIDATION_FAILED',
            'This version of the plan was replaced by a newer one, so it can no longer be ' +
              'approved. Scroll down to the latest version and approve that.',
          );
    }

    ctx.activityLog.logEvent({
      actor: 'user',
      type: 'project.plan_approved',
      severity: 'info',
      project_id: plan.project_id,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { planId: id, version: plan.version },
    });
    return ipcOk(PlanSchemas.approve.output.parse({ ok: true }));
  },

  /** M11's, for the reasons given on `brief.requestEdit`: revising a plan
   * is the Director's judgement, not a status flip, and §5.2 has no event
   * type for it. No §14.2 button depends on it. */
  requestEdit: stub('M11'),
};
