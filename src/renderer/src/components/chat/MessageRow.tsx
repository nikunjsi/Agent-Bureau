import { useEffect, useRef } from 'react';
import type { ConversationMessage } from '../../../../shared/models/conversationMessage';
import { isUnreadForUser } from '../../../../shared/models/conversationMessage';
import type { Checkpoint } from '../../../../shared/models/checkpoint';
import type { Brief } from '../../../../shared/models/brief';
import type { z } from 'zod';
import type { ErrorPayloadSchema } from '../../../../shared/models/chatPayloads';
import { formatClockTime } from './format';
import { type NoticeError } from '../ErrorNotice';
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
  checkpointError: NoticeError | null;
  onAnswer: (checkpointId: string, input: { optionId?: string; freeText?: string }) => void;
  onAnswerPermission: (checkpointId: string, allow: boolean) => void;
  onRemedy: (remedy: z.infer<typeof ErrorPayloadSchema>['remedy']) => void;
  /** Sends text as an ordinary message — a question chip's own label. */
  onSendText: (text: string) => void;
  /** Fills the composer instead of sending: Discuss, and a plan's Edit. */
  onDraft: (text: string) => void;
  onEditBrief: (brief: Brief) => void;
  /** Called when this message has been **seen**: scrolled into view in a
   * focused window. Not on render — see `ChatView`. */
  onSeen: (messageId: string) => void;
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
export function MessageRow(props: MessageRowProps): React.JSX.Element {
  const { message, onSeen } = props;
  const isUser = message.author === 'user';
  const rowRef = useRef<HTMLLIElement>(null);
  const unread = isUnreadForUser(message);

  /**
   * §28 M9 item 7's other half: **when** a message counts as read.
   *
   * §14 does not say, so the rule is chosen here and stated: a message is
   * read when it has been **scrolled into view in a focused window**.
   * Marking on render would stamp everything the moment a conversation
   * loads, including the twenty messages below the fold — which is the
   * failure mode that makes an unread badge worthless. Marking on window
   * focus alone has the same problem.
   *
   * `document.hasFocus()` is re-checked when focus returns, not only on
   * mount: the common case is a notification arriving while the window is
   * behind something else, and the message must stay unread until the
   * person actually looks.
   */
  useEffect(() => {
    if (!unread) return;
    const element = rowRef.current;
    if (element === null) return;

    let done = false;
    const markIfVisibleAndFocused = (visible: boolean): void => {
      if (done || !visible || !document.hasFocus()) return;
      done = true;
      onSeen(message.id);
    };

    let visible = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible = entry.isIntersecting;
          markIfVisibleAndFocused(visible);
        }
      },
      // Most of the row, not a single pixel of it: a message clipped to
      // its last line at the bottom of the viewport has not been read.
      { threshold: 0.6 },
    );
    observer.observe(element);

    const onFocus = (): void => markIfVisibleAndFocused(visible);
    window.addEventListener('focus', onFocus);
    return () => {
      observer.disconnect();
      window.removeEventListener('focus', onFocus);
    };
  }, [unread, message.id, onSeen]);

  return (
    <li
      ref={rowRef}
      // A stable handle for the e2e that checks §14.7's "status never by
      // colour alone": it has to address one specific message's row while
      // every colour on the page is forced to black on white, and text
      // content is exactly what it must not select on.
      data-message-id={message.id}
      data-message-status={message.status}
      className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-stretch'}`}
    >
      <p className="flex items-baseline gap-2 text-xs text-bureau-text-muted">
        <span className="font-medium text-bureau-text">{AUTHOR_LABEL[message.author]}</span>
        <time dateTime={message.created_at} title={message.created_at}>
          {formatClockTime(message.created_at)}
        </time>
        {/* §14.7: status never by colour alone. All three states a message
            can be in are told apart by WORDS here — "typing…" while it
            streams, "interrupted" below when it aborted, and neither when
            it is complete — which is what makes them survive a monochrome
            screen, high-contrast mode, or a screen reader. The dot is
            decorative; `motion-safe` is what §14.7's
            `prefers-reduced-motion` means for it. */}
        {message.status === 'streaming' && (
          <span className="flex items-center gap-1">
            <span aria-hidden="true" className="motion-safe:animate-pulse">
              ●
            </span>{' '}
            typing…
          </span>
        )}
      </p>

      <div
        className={`max-w-full rounded-md ${
          isUser ? 'bg-bureau-accent/10 px-3 py-2' : 'bg-transparent'
        }`}
      >
        <KindBody {...props} />

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
  onSendText,
  onDraft,
  onEditBrief,
}: MessageRowProps): React.JSX.Element {
  switch (message.kind) {
    case 'question':
      return <QuestionBubble message={message} onAnswer={onSendText} />;
    case 'brief':
      return <BriefCard message={message} onDiscuss={onDraft} onEditBrief={onEditBrief} />;
    case 'plan':
      return <PlanCard message={message} onDiscuss={onDraft} onEditBrief={onEditBrief} />;
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
      return <TextBubble message={message} />;
  }
}
