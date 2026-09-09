import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { Conversation } from '../../../../shared/models/conversation';
import type { Brief } from '../../../../shared/models/brief';
import type { ErrorPayloadSchema } from '../../../../shared/models/chatPayloads';
import { useBureauStore } from '../../store/bureauStore';
import { refetchConversation } from '../../ipcBridge';
import { MessageRow } from './MessageRow';
import { Composer } from './Composer';
import { BriefEditor } from './BriefEditor';
import { PausedBanner } from './PausedBanner';

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
  const [draft, setDraft] = useState<{ text: string; token: number } | null>(null);
  const [editingBrief, setEditingBrief] = useState<Brief | null>(null);
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

  /**
   * A message has been seen (`MessageRow` owns the rule for when).
   *
   * Nothing optimistic happens here: the Core stamps `read_at` and pushes
   * the updated row back, and the badge changes because that row changed.
   * A failure is genuinely not worth telling the user about — the message
   * simply stays unread, which is the harmless direction — but it is
   * logged rather than swallowed.
   *
   * `useCallback` is load-bearing: `MessageRow`'s effect depends on this
   * identity, and a fresh function each render would tear down and rebuild
   * every observer on the list on every keystroke in the composer.
   */
  const markSeen = useCallback(
    (messageId: string): void => {
      if (activeConversationId === null) return;
      void window.bureau.chat
        .markRead({ conversationId: activeConversationId, messageId })
        .then((result) => {
          if (!result.ok) console.warn('[chat] markRead failed', result.error);
        }, console.error);
    },
    [activeConversationId],
  );

  const sendText = useCallback(
    (text: string): void => {
      if (activeConversationId === null) return;
      void window.bureau.chat
        .send({ conversationId: activeConversationId, body: text, attachments: [] })
        .then((result) => {
          if (!result.ok) console.warn('[chat] send failed', result.error);
        }, console.error);
    },
    [activeConversationId],
  );

  // Filling the composer rather than sending: Discuss, and a plan's "ask
  // for changes". The token makes a second press with the same text still
  // refill a box the user has since cleared.
  const fillComposer = useCallback((text: string): void => {
    setDraft((previous) => ({ text, token: (previous?.token ?? 0) + 1 }));
  }, []);

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

  // Whether a reply is arriving right now. Derived from the messages the
  // Core sent, not tracked separately — the Stop button must be offered
  // exactly when there is something to stop.
  const streaming = chat.messages.some((message) => message.status === 'streaming');

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
        {chat.messages.length === 0 && chat.status === 'ready' && (
          // §14.6's empty state, inside the list rather than replacing the
          // screen: the composer must still be there, because "say
          // something" is the next action and hiding the box is the one
          // way to make an empty conversation permanent.
          <li className="p-6 text-center text-sm text-bureau-text-muted">
            Nothing said yet. Describe what you want built — though note that no Director has been
            hired in this build, so nothing will answer yet.
          </li>
        )}
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
            onSendText={sendText}
            onDraft={fillComposer}
            onEditBrief={setEditingBrief}
            onSeen={markSeen}
          />
        ))}
      </ol>
      <PausedBanner />
      <Composer
        conversationId={activeConversation.id}
        streaming={streaming}
        draft={draft}
        onSent={() => setDraft(null)}
      />
      {editingBrief !== null && (
        <BriefEditor
          briefId={editingBrief.id}
          initialMarkdown={editingBrief.markdown}
          onClose={() => setEditingBrief(null)}
          onSaved={() => setEditingBrief(null)}
        />
      )}
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
