import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { Conversation } from '../../../../shared/models/conversation';
import type { ErrorPayloadSchema } from '../../../../shared/models/chatPayloads';
import { useBureauStore } from '../../store/bureauStore';
import { refetchConversation } from '../../ipcBridge';
import { MessageRow } from './MessageRow';

/**
 * §14.2's chat view — §14.1's default tab, and §1's "the conversation is
 * the product".
 *
 * ## Where its state comes from
 *
 * Messages come from `chat.listMessages` and are updated by pushed
 * `chatMessage` events; both land in the store, which owns the no-optimistic
 * -appends and gap-recovery rules (see `bureauStore`). Checkpoints come from
 * the `checkpoints` slice, which the Core keeps current — one piece of state
 * shared with `checkpoints.listPending` (§9.4), not a second query.
 *
 * This component fetches on three occasions and never on a timer: the
 * conversation changes, the window re-hydrates (`hydrationEpoch`), or the
 * store reports a dropped push.
 */
export function ChatView(): React.JSX.Element {
  const hydrationEpoch = useBureauStore((state) => state.hydrationEpoch);
  const chat = useBureauStore((state) => state.chat);
  const checkpoints = useBureauStore((state) => state.checkpoints);
  const setActiveTab = useBureauStore((state) => state.setActiveTab);

  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [submittingCheckpointId, setSubmittingCheckpointId] = useState<string | null>(null);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Which conversations exist. Re-read on re-hydrate, because a window
  // reload is also how a new one becomes visible.
  useEffect(() => {
    let cancelled = false;
    window.bureau.chat.listConversations({ projectId: null }).then((result) => {
      if (cancelled) return;
      setConversations(result.ok ? result.data.items : []);
    }, console.error);
    return () => {
      cancelled = true;
    };
  }, [hydrationEpoch]);

  // The conversation to show. Until there is a project switcher (M11 gives
  // conversations something to switch between), the most recent one is the
  // one the user means.
  const activeConversation =
    conversations === null || conversations.length === 0
      ? null
      : (conversations[conversations.length - 1] ?? null);

  const activeConversationId = activeConversation?.id ?? null;
  useEffect(() => {
    if (activeConversationId === null) return;
    void refetchConversation(activeConversationId);
  }, [activeConversationId, hydrationEpoch]);

  // Keep the newest message in view, the way every chat does — but only
  // when the user is already at the bottom, so reading back through a
  // transcript is not yanked away by an incoming reply.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceFromBottom < 120) list.scrollTop = list.scrollHeight;
  }, [chat.messages]);

  const answer = async (
    checkpointId: string,
    input: { optionId?: string; freeText?: string },
  ): Promise<void> => {
    setSubmittingCheckpointId(checkpointId);
    setCheckpointError(null);
    const result = await window.bureau.checkpoints.answer({ id: checkpointId, ...input });
    setSubmittingCheckpointId(null);
    // The card does not remove itself. The Core emits `checkpoint.answered`,
    // which pushes a fresh `checkpoints` slice, and the card goes because
    // the checkpoint is no longer pending — one piece of state deciding,
    // not the view guessing ahead of it.
    if (!result.ok) setCheckpointError(result.error.message);
  };

  const answerPermission = async (checkpointId: string, allow: boolean): Promise<void> => {
    setSubmittingCheckpointId(checkpointId);
    setCheckpointError(null);
    const result = await window.bureau.checkpoints.answerPermission({ id: checkpointId, allow });
    setSubmittingCheckpointId(null);
    if (!result.ok) {
      setCheckpointError(result.error.message);
      return;
    }
    if (!result.data.holdReleased) {
      // A real outcome, and one the user has to be told about: the answer
      // was recorded, but the agent had already stopped waiting.
      setCheckpointError(
        'Your answer was recorded, but the employee had already stopped waiting for it.',
      );
    }
  };

  const followRemedy = (remedy: z.infer<typeof ErrorPayloadSchema>['remedy']): void => {
    if (remedy === null) return;
    switch (remedy.kind) {
      case 'answer_checkpoint':
        setActiveTab('checkpoints');
        return;
      case 'open_path':
        if (remedy.targetId !== null) void window.bureau.system.openPath({ path: remedy.targetId });
        return;
      default:
        // `reconnect_engine`, `raise_budget` and `retry` have no screen to
        // send anyone to yet (settings panels are M13, retry needs the
        // composer). Doing nothing quietly would be worse than saying so,
        // so the button is rendered and this is where its destination
        // lands when it exists.
        console.warn(`[chat] no destination yet for remedy '${remedy.kind}'`);
    }
  };

  if (conversations === null || (chat.status === 'loading' && chat.messages.length === 0)) {
    return <Empty title="Loading…" body="" />;
  }

  if (activeConversation === null) {
    return (
      <Empty
        title="No conversation yet"
        body="This is where you will talk to the Director — describe what you want built, answer a few questions, approve the plan. The Director itself arrives in a later build; everything it says will appear here."
      />
    );
  }

  if (chat.messages.length === 0 && chat.status === 'ready') {
    return (
      <Empty
        title="Nothing said yet"
        body="This conversation is empty. Messages from the Director will appear here as they arrive."
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {chat.status === 'error' && (
        <p
          role="alert"
          className="border-b border-bureau-border px-3 py-2 text-sm text-bureau-error"
        >
          This conversation could not be loaded. It is still safe on disk — reopening the window
          will try again.
        </p>
      )}
      <ol
        ref={listRef}
        aria-label="Conversation"
        aria-live="polite"
        className="flex flex-1 flex-col gap-4 overflow-y-auto p-3"
      >
        {chat.messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            checkpoint={
              message.checkpoint_id === null
                ? null
                : (checkpoints.find((c) => c.id === message.checkpoint_id) ?? null)
            }
            submittingCheckpointId={submittingCheckpointId}
            checkpointError={checkpointError}
            onAnswer={(id, input) => void answer(id, input)}
            onAnswerPermission={(id, allow) => void answerPermission(id, allow)}
            onRemedy={followRemedy}
          />
        ))}
      </ol>
      <p className="border-t border-bureau-border px-3 py-2 text-xs text-bureau-text-muted">
        {/* §14.6: an empty state that says what happens next, rather than a
            composer that looks usable and is not. */}
        Writing back arrives in the next build.
      </p>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="font-medium text-bureau-text">{title}</p>
      <p className="max-w-sm text-sm text-bureau-text-muted">{body}</p>
    </div>
  );
}
