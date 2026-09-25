import { appendChatMessage } from '../../chat/appendMessage';
import { resolveDirectorConversation } from '../../director/directorConversation';
import { findEarlierAnswer } from '../../director/alreadyAnswered';
import { setConversationDirectorState } from '../../db/repositories/conversations';
import { getSetting } from '../../db/repositories/settings';
import {
  QuestionBatchPayloadSchema,
  ReportPayloadSchema,
  SummaryPayloadSchema,
} from '../../../shared/models/chatPayloads';
import type { Conversation } from '../../../shared/models/conversation';
import { ReportArgsSchema } from './schemas';
import type { ToolHandler, ToolHandlerContext, ToolHandlerResult } from './types';

/**
 * §7.9's `bureau_report`: *"{ kind: 'report'|'summary', body, payload? } —
 * posts a chat message."* A Director tool (M11 row S1-12a).
 *
 * This is how the Director says something structured — a progress report,
 * a phase summary — as distinct from its own prose, which streams into the
 * conversation as it is generated (row S1-13). Both end up as messages the
 * user reads; only this one has a card behind it.
 *
 * The payload is validated against the same schema the renderer's card
 * reads, so a malformed report is refused at the tool with something the
 * agent can act on, rather than stored and rendered as a blank card.
 *
 * **`kind: 'question'`** (M11 S2-2a, decision E-6) is how the Director asks
 * the user anything, and intake's rules are enforced here in plain code:
 * see `questionRefusal`.
 */

export const handleReport: ToolHandler = (ctx, rawArgs) => {
  const parsed = ReportArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return refuse(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }

  // The card the renderer draws is validated here, where the kind is known.
  const cardSchema =
    parsed.data.kind === 'report'
      ? ReportPayloadSchema
      : parsed.data.kind === 'summary'
        ? SummaryPayloadSchema
        : QuestionBatchPayloadSchema;
  const card = cardSchema.safeParse(parsed.data.payload);
  if (!card.success) {
    return refuse(
      `the ${parsed.data.kind} payload is not usable: ${card.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  // The Director posts into the conversation it is having: its turn's
  // (M11 S2-1a). Before any conversation exists there is nowhere to post,
  // and saying so is better than inventing one the user never opened.
  const conversation = resolveDirectorConversation(ctx.db, ctx.supervisorRegistry);
  if (!conversation) return refuse('there is no conversation to post into yet.');

  // Intake's round, written with the card in one transaction, so the card
  // and the round are one state change with the card's one event.
  let roundData: Record<string, unknown> | null = null;
  if (parsed.data.kind === 'question') {
    const questions = (card.data as { questions: { text: string }[] }).questions;
    const refusal = questionRefusal(ctx, conversation, questions);
    if (refusal !== null) return refusal;
    if (conversation.director_state === 'INTAKE') {
      const data = conversation.director_state_data ?? {};
      roundData = { ...data, intakeRounds: intakeRoundsOf(data) + 1 };
    }
  }

  // Pushed to the open window as it is written (M11 S2-0): a card the user
  // only sees after a re-hydrate is a card the conversation waits on.
  const message = appendChatMessage(
    {
      db: ctx.db,
      activityLog: ctx.activityLog,
      ...(ctx.chatBroadcaster ? { broadcaster: ctx.chatBroadcaster } : {}),
    },
    {
      conversationId: conversation.id,
      ...(conversation.project_id ? { projectId: conversation.project_id } : {}),
      author: 'director',
      kind: parsed.data.kind,
      body: parsed.data.body,
      payload: card.data,
    },
    roundData === null
      ? undefined
      : () => setConversationDirectorState(ctx.db, conversation.id, 'INTAKE', roundData!),
  );

  return { ok: true, data: { messageId: message.id } };
};

/**
 * §8.1's rules for asking, in plain code (M11 S2-2a):
 *
 * - **In intake, 2 to 4 at a time** — "never one at a time", and never more
 *   than a person answers in one go. Outside intake one question is allowed:
 *   the company conversation's "which project do you mean?" is one question
 *   with the projects as its options (Nikunj's decision of 2026-09-25).
 * - **No round past `intake.maxRounds`.** "A brief with visible assumptions
 *   is far more useful than a fourth round of questions."
 * - **Invariant #9**: a question the decision log, the brief or memory
 *   already answers is refused, with the answer handed back
 *   (`findEarlierAnswer`).
 *
 * `null` when the batch may be posted.
 */
function questionRefusal(
  ctx: ToolHandlerContext,
  conversation: Conversation,
  questions: readonly { text: string }[],
): ToolHandlerResult | null {
  const inIntake = conversation.director_state === 'INTAKE';
  if (inIntake && questions.length < 2) {
    return refuse(
      `ask intake's questions 2 to 4 at a time, never one at a time (§8.1). You sent ${questions.length}.`,
    );
  }
  if (inIntake) {
    const maxRounds = getSetting(ctx.db, 'intake.maxRounds');
    const asked = intakeRoundsOf(conversation.director_state_data ?? {});
    if (asked >= maxRounds) {
      return refuse(
        `you have asked ${asked} rounds of questions, which is the cap (intake.maxRounds = ${maxRounds}). ` +
          'Do not ask another: write the brief now, with an explicit Assumptions section and the ' +
          'open questions listed, and let the user correct it.',
      );
    }
  }
  const answered = questions.flatMap((question) => {
    const earlier = findEarlierAnswer(ctx.db, {
      projectId: conversation.project_id,
      question: question.text,
    });
    return earlier === null ? [] : [{ question: question.text, earlier }];
  });
  if (answered.length > 0) {
    return refuse(
      'some of these are already answered, and invariant #9 is never to ask again what is known. ' +
        answered
          .map(
            ({ question, earlier }) =>
              `"${question}" — the ${earlier.source} already has "${earlier.matched}": ${earlier.answer}`,
          )
          .join(' | ') +
        ' Use those answers, and ask only what is still open.',
    );
  }
  return null;
}

function intakeRoundsOf(data: Record<string, unknown>): number {
  const rounds = data['intakeRounds'];
  return typeof rounds === 'number' && Number.isInteger(rounds) && rounds >= 0 ? rounds : 0;
}

function refuse(message: string): ToolHandlerResult {
  return { ok: false, code: 'VALIDATION_FAILED', message: `bureau_report: ${message}` };
}
