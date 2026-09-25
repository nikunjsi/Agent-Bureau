import { getPlanById } from '../../db/repositories/plans';
import { approvePlanWithStage } from '../../projects/planWriting';
import { ipcError, ipcOk } from '../../../shared/ipc/envelope';
import { Plan as PlanSchemas } from '../../../shared/ipc/schemas/plan';
import { type Handler } from './types';
import { requestPlanChanges } from '../../projects/documentChanges';

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
    // M11 S2-4: the approval, the project's plan, planning → executing and
    // the Director's SUPERVISING, in one transaction (`planWriting.ts`).
    const outcome = approvePlanWithStage(
      {
        db: ctx.db,
        activityLog: ctx.activityLog,
        ...(ctx.chatBroadcaster ? { broadcaster: ctx.chatBroadcaster } : {}),
      },
      id,
    );
    switch (outcome.kind) {
      case 'not_found':
        return ipcError('NOT_FOUND', `No plan with id "${id}".`, { type: 'retry' });
      case 'already_approved':
        return ipcOk(PlanSchemas.approve.output.parse({ ok: true }));
      case 'superseded':
        return ipcError(
          'VALIDATION_FAILED',
          'This version of the plan was replaced by a newer one, so it can no longer be ' +
            'approved. Scroll down to the latest version and approve that.',
        );
      case 'approved':
        // The Director supervises from here. The assignment loop that hands
        // tasks to employees is M11 §S3's (S3-2); until then the approval
        // reaches the Director, which is what is waiting on it.
        if (outcome.conversationId !== null) {
          ctx.directorTriggers?.offerUserDecision?.({
            conversationId: outcome.conversationId,
            key: `plan_approved:${id}`,
            text: 'The user approved the plan. The work can start: supervise it from here.',
          });
        }
        return ipcOk(PlanSchemas.approve.output.parse({ ok: true }));
    }
  },

  /** M11 S2-3b: the plan card's "Ask for changes" — the plan's Edit, since a
   * plan has no text for the user to rewrite. Back to planning, one
   * `project.plan_changes_requested`, the words in the conversation, and a
   * turn for the Director (`documentChanges.ts`). */
  requestEdit: (input, ctx) => {
    const { id, feedback } = PlanSchemas.requestEdit.input.parse(input);
    const outcome = requestPlanChanges(
      {
        db: ctx.db,
        activityLog: ctx.activityLog,
        ...(ctx.chatBroadcaster ? { broadcaster: ctx.chatBroadcaster } : {}),
      },
      { planId: id, feedback },
    );
    switch (outcome.kind) {
      case 'not_found':
        return ipcError('NOT_FOUND', `No plan with id "${id}".`, { type: 'retry' });
      case 'refused':
        return ipcError('VALIDATION_FAILED', outcome.message);
      case 'requested':
        ctx.directorTriggers?.offerUserDecision?.({
          conversationId: outcome.conversationId,
          key: `plan_changes:${outcome.messageId}`,
          text: outcome.directorText,
        });
        return ipcOk(PlanSchemas.requestEdit.output.parse({ ok: true }));
    }
  },
};
