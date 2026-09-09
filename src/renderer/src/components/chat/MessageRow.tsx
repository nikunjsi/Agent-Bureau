import type { ConversationMessage } from '../../../../shared/models/conversationMessage';
import type { Checkpoint } from '../../../../shared/models/checkpoint';
import type { z } from 'zod';
import type { ErrorPayloadSchema } from '../../../../shared/models/chatPayloads';
import { formatClockTime } from './format';
import {
  AnsweredCheckpointNote,
  BriefCard,
  CheckpointCard,
  ErrorBubble,
  PlanCard,
  QuestionBubble,
  ReportCard,
  SummaryCard,
  TextBubble,
} from './kinds';

const AUTHOR_LABEL: Record<ConversationMessage['author'], string> = {
  user: 'You',
  director: 'Director',
  system: 'Bureau',
};

export interface MessageRowProps {
  message: ConversationMessage;
  /** The live checkpoint this message refers to, if it is still pending.
   * Looked up by the view from the `checkpoints` slice — this component
   * does not query and does not decide what "pending" means. */
  checkpoint: Checkpoint | null;
  submittingCheckpointId: string | null;
  checkpointError: string | null;
  onAnswer: (checkpointId: string, input: { optionId?: string; freeText?: string }) => void;
  onAnswerPermission: (checkpointId: string, allow: boolean) => void;
  onRemedy: (remedy: z.infer<typeof ErrorPayloadSchema>['remedy']) => void;
}

/**
 * One message: who said it, when, what state it is in, and its kind's own
 * rendering.
 *
 * ## The interrupted marker
 *
 * `status === 'aborted'` gets a visible, labelled marker — the gate's
 * second half. The failure being designed against is not an ugly message;
 * it is a **truncated message that looks complete**, which a user reads as
 * the Director's actual answer and acts on. So the marker is a line of its
 * own, in words, next to the text that did arrive.
 *
 * Two causes produce this state — `chat.stop`, and a crash mid-stream that
 * `reconcile()` cleans up on the next launch — and they render identically,
 * on purpose. "This reply was interrupted" is the whole of what a user
 * needs; which of the two interrupted it changes nothing they would do.
 */
export function MessageRow({
  message,
  checkpoint,
  submittingCheckpointId,
  checkpointError,
  onAnswer,
  onAnswerPermission,
  onRemedy,
}: MessageRowProps): React.JSX.Element {
  const isUser = message.author === 'user';
  return (
    <li className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-stretch'}`}>
      <p className="flex items-baseline gap-2 text-xs text-bureau-text-muted">
        <span className="font-medium text-bureau-text">{AUTHOR_LABEL[message.author]}</span>
        <time dateTime={message.created_at} title={message.created_at}>
          {formatClockTime(message.created_at)}
        </time>
        {message.status === 'streaming' && (
          <span className="flex items-center gap-1">
            <span aria-hidden="true">●</span> typing…
          </span>
        )}
      </p>

      <div
        className={`max-w-full rounded-md ${
          isUser ? 'bg-bureau-accent/10 px-3 py-2' : 'bg-transparent'
        }`}
      >
        <KindBody
          message={message}
          checkpoint={checkpoint}
          submittingCheckpointId={submittingCheckpointId}
          checkpointError={checkpointError}
          onAnswer={onAnswer}
          onAnswerPermission={onAnswerPermission}
          onRemedy={onRemedy}
        />

        {message.status === 'aborted' && (
          <p
            // Icon + words, never colour alone (§14.7), and `role="note"`
            // so a screen reader announces it as commentary on the message
            // rather than as more of the message.
            role="note"
            className="mt-1 flex items-center gap-1.5 rounded border border-bureau-warn/50 bg-bureau-warn/10 px-2 py-1 text-xs text-bureau-warn"
          >
            <span aria-hidden="true">⊘</span>
            This reply was interrupted and is incomplete.
          </p>
        )}
        {message.status === 'error' && (
          <p
            role="note"
            className="mt-1 flex items-center gap-1.5 rounded border border-bureau-error/50 bg-bureau-error/10 px-2 py-1 text-xs text-bureau-error"
          >
            <span aria-hidden="true">⚠</span>
            This reply failed part-way through.
          </p>
        )}
      </div>
    </li>
  );
}

function KindBody({
  message,
  checkpoint,
  submittingCheckpointId,
  checkpointError,
  onAnswer,
  onAnswerPermission,
  onRemedy,
}: MessageRowProps): React.JSX.Element {
  switch (message.kind) {
    case 'question':
      return <QuestionBubble message={message} />;
    case 'brief':
      return <BriefCard message={message} />;
    case 'plan':
      return <PlanCard message={message} />;
    case 'report':
      return <ReportCard message={message} />;
    case 'summary':
      return <SummaryCard message={message} />;
    case 'error':
      return <ErrorBubble message={message} onRemedy={onRemedy} />;
    case 'checkpoint':
      // A `checkpoint` message with no live checkpoint means it has been
      // answered, expired, or cancelled — the slice only carries pending
      // rows. That is a state, not a missing value.
      return checkpoint === null ? (
        <AnsweredCheckpointNote body={message.body} />
      ) : (
        <CheckpointCard
          checkpoint={checkpoint}
          submitting={submittingCheckpointId === checkpoint.id}
          error={submittingCheckpointId === checkpoint.id ? checkpointError : null}
          onAnswer={(input) => onAnswer(checkpoint.id, input)}
          onAnswerPermission={(allow) => onAnswerPermission(checkpoint.id, allow)}
        />
      );
    default:
      return <TextBubble body={message.body} />;
  }
}
