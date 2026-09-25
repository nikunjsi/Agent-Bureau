import { resolveDirectorConversation } from '../../director/directorConversation';
import { InvalidDirectorTransitionError } from '../../director/directorState';
import { getProjectById } from '../../db/repositories/projects';
import { BriefRefusedError, writeBriefFromDirector } from '../../projects/briefApproval';
import { ProjectStageRefusedError, setProjectStageByDirector } from '../../projects/projectStage';
import { BriefDocumentSchema } from '../../../shared/models/brief';
import { WriteBriefArgsSchema } from './schemas';
import type { ToolHandler, ToolHandlerResult } from './types';

/**
 * §7.9's `bureau_write_brief`: *"Creates a `briefs` row, posts a `brief`
 * chat message, sets `awaiting_approval`."* A Director tool (M11 S2-3a).
 *
 * From intake it first makes §8's `intake → brief` move (A.3's
 * `INTAKE → DRAFTING_BRIEF`) — writing the brief is how intake ends — and
 * from `DRAFTING_BRIEF` (after the user asked for changes) it writes the
 * next version. The brief is validated before anything moves, so a
 * refused brief leaves the project exactly where it was.
 */
export const handleWriteBrief: ToolHandler = (ctx, rawArgs) => {
  const args = WriteBriefArgsSchema.safeParse(rawArgs);
  if (!args.success) return refuse('pass the brief as { brief: { … } }, §8.3’s fields.');
  const document = BriefDocumentSchema.safeParse(args.data.brief);
  if (!document.success) {
    return refuse(
      `the brief is not §8.3's: ${document.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const conversation = resolveDirectorConversation(ctx.db, ctx.supervisorRegistry);
  if (conversation === null || conversation.project_id === null) {
    return refuse('this conversation is not about a project, so there is no brief to write.');
  }
  const project = getProjectById(ctx.db, conversation.project_id);
  if (project === null) return refuse('this conversation’s project no longer exists.');

  try {
    if (project.stage === 'intake') {
      setProjectStageByDirector(
        { db: ctx.db, activityLog: ctx.activityLog },
        {
          projectId: project.id,
          conversationId: conversation.id,
          to: 'brief',
          reason: 'The Director wrote the brief.',
        },
      );
    }
    const written = writeBriefFromDirector(
      {
        db: ctx.db,
        activityLog: ctx.activityLog,
        ...(ctx.chatBroadcaster ? { broadcaster: ctx.chatBroadcaster } : {}),
      },
      { projectId: project.id, conversationId: conversation.id, brief: document.data },
    );
    return { ok: true, data: written };
  } catch (err) {
    if (err instanceof ProjectStageRefusedError || err instanceof BriefRefusedError) {
      return refuse(err.message);
    }
    if (err instanceof InvalidDirectorTransitionError) {
      return refuse(
        `a brief is written from intake or while redrafting one, and your state here is ${err.from}.`,
      );
    }
    throw err;
  }
};

function refuse(message: string): ToolHandlerResult {
  return { ok: false, code: 'VALIDATION_FAILED', message: `bureau_write_brief: ${message}` };
}
