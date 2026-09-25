import { resolveDirectorConversation } from '../../director/directorConversation';
import { InvalidDirectorTransitionError } from '../../director/directorState';
import { PlanRefusedError, writePlanFromDirector } from '../../projects/planWriting';
import { WritePlanArgsSchema } from './schemas';
import type { ToolHandler, ToolHandlerResult } from './types';

/**
 * §7.9's `bureau_write_plan`: *"Creates `plans` + `phases` + `tasks` +
 * `task_deps` in one transaction; rejects empty `acceptance_criteria` or
 * any dependency cycle."* A Director tool (M11 S2-4). Refused unless the
 * brief is approved — `isBriefApproved`, the one answer (invariant #2).
 * The rules and the transaction are `planWriting.ts`'s.
 */
export const handleWritePlan: ToolHandler = (ctx, rawArgs) => {
  const parsed = WritePlanArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return refuse(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const conversation = resolveDirectorConversation(ctx.db, ctx.supervisorRegistry);
  if (conversation === null || conversation.project_id === null) {
    return refuse('this conversation is not about a project, so there is no plan to write.');
  }
  try {
    const written = writePlanFromDirector(
      {
        db: ctx.db,
        activityLog: ctx.activityLog,
        ...(ctx.chatBroadcaster ? { broadcaster: ctx.chatBroadcaster } : {}),
      },
      { projectId: conversation.project_id, conversationId: conversation.id, plan: parsed.data },
    );
    return { ok: true, data: written };
  } catch (err) {
    if (err instanceof PlanRefusedError) return refuse(err.message);
    if (err instanceof InvalidDirectorTransitionError) {
      return refuse(`a plan is written while planning, and your state here is ${err.from}.`);
    }
    throw err;
  }
};

function refuse(message: string): ToolHandlerResult {
  return { ok: false, code: 'VALIDATION_FAILED', message: `bureau_write_plan: ${message}` };
}
