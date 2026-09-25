import type Database from 'better-sqlite3';
import { resolveDirectorConversation } from '../../director/directorConversation';
import { InvalidDirectorTransitionError } from '../../director/directorState';
import {
  createProject,
  ProjectCreationError,
  projectNameFromRequest,
} from '../../projects/createProject';
import { ProjectStageRefusedError, setProjectStageByDirector } from '../../projects/projectStage';
import { SetProjectStageArgsSchema } from './schemas';
import type { ToolHandler, ToolHandlerResult } from './types';

/**
 * §7.9's `bureau_set_project_stage`: *"Advances the lifecycle (§8); creating
 * a project from a conversation is `stage='intake'`."* A Director tool (M11
 * S2-1b).
 *
 * - **`intake`** creates a project through the one creation function
 *   (`createProject`). From the company conversation, that conversation is
 *   bound to it (§5.1) — the Director judged it new work where the intent
 *   rules did not. From another project's conversation, the new project gets
 *   a conversation of its own: that is the user accepting the Director's
 *   offer of a new project, and the current project is left as it was.
 * - **Any other stage** is a move in §8's table, made with its A.3 partner,
 *   or refused — including every move that is the user's to make.
 *
 * The conversation is the one of the turn the Director is taking
 * (`resolveDirectorConversation`), never an id it passes: a stage is moved
 * where the Director is.
 */
export const handleSetProjectStage: ToolHandler = (ctx, rawArgs) => {
  const parsed = SetProjectStageArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return refuse(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const { stage, reason, name } = parsed.data;
  const conversation = resolveDirectorConversation(ctx.db, ctx.supervisorRegistry);
  if (conversation === null) return refuse('there is no conversation to work in yet.');

  if (stage === 'intake') {
    const intoNewConversation = conversation.project_id !== null;
    if (intoNewConversation && name === undefined) {
      return refuse(
        "this conversation is already about a project, so 'intake' starts a separate one: give it a short name.",
      );
    }
    try {
      const created = createProject(
        { db: ctx.db, activityLog: ctx.activityLog },
        {
          companyId: conversation.company_id,
          name: name ?? projectNameFromRequest(latestUserWords(ctx.db, conversation.id) ?? reason),
          conversation: intoNewConversation ? 'new' : { bind: conversation.id },
          actor: 'director',
          reason,
        },
      );
      return {
        ok: true,
        data: {
          projectId: created.project.id,
          displayKey: created.project.display_key,
          name: created.project.name,
          conversationId: created.conversation.id,
          conversation: intoNewConversation ? 'new' : 'this one',
        },
      };
    } catch (err) {
      if (err instanceof InvalidDirectorTransitionError) {
        return refuse(
          `a project starts from an idle conversation, and your state here is ${err.from}.`,
        );
      }
      if (err instanceof ProjectCreationError) return refuse(err.message);
      throw err;
    }
  }

  if (conversation.project_id === null) {
    return refuse(
      `this conversation is not about a project, so there is no stage to move to '${stage}'.`,
    );
  }
  try {
    const moved = setProjectStageByDirector(
      { db: ctx.db, activityLog: ctx.activityLog },
      { projectId: conversation.project_id, conversationId: conversation.id, to: stage, reason },
    );
    return { ok: true, data: moved };
  } catch (err) {
    if (err instanceof ProjectStageRefusedError) return refuse(err.message);
    throw err;
  }
};

function refuse(message: string): ToolHandlerResult {
  return { ok: false, code: 'VALIDATION_FAILED', message: `bureau_set_project_stage: ${message}` };
}

function latestUserWords(db: Database.Database, conversationId: string): string | null {
  const row = db
    .prepare(
      "SELECT body FROM conversation_messages WHERE conversation_id = ? AND author = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(conversationId) as { body: string } | undefined;
  return row?.body ?? null;
}
