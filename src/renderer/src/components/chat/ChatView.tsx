import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { Conversation } from '../../../../shared/models/conversation';
import type { Brief } from '../../../../shared/models/brief';
import type { ErrorPayloadSchema } from '../../../../shared/models/chatPayloads';
import { useBureauStore } from '../../store/bureauStore';
import { useCheckpointAnswering } from '../checkpoints/useCheckpointAnswering';
import { loadOlderMessages, refetchConversation } from '../../ipcBridge';
import { MessageRow } from './MessageRow';
import { Composer } from './Composer';
import { BriefEditor } from './BriefEditor';
import { PausedBanner } from './PausedBanner';
import { ReviewerNotice } from './ReviewerNotice';
import { followRemedy } from '../remedies';

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

  // P-4: when an earlier page is prepended, keep the message the user was
  // reading where it was. Without this the list's content grows above the
  // viewport and the view jumps to the top of the page just loaded.
  const heightBeforeOlderPage = useRef<number | null>(null);
  const showEarlier = (): void => {
    if (activeConversationId === null) return;
    heightBeforeOlderPage.current = listRef.current?.scrollHeight ?? null;
    void loadOlderMessages(activeConversationId);
  };
  useLayoutEffect(() => {
    const list = listRef.current;
    const before = heightBeforeOlderPage.current;
    if (list === null || before === null || chat.loadingOlder) return;
    heightBeforeOlderPage.current = null;
    list.scrollTop += list.scrollHeight - before;
  }, [chat.messages, chat.loadingOlder]);

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

  // X-16: answering is one path, shared with the Checkpoints view. It also
  // records the session's answered list §14.4 asks that view to show, which
  // is why an answer given in chat appears there too — one act, both
  // surfaces.
  const {
    submittingId: submittingCheckpointId,
    error: checkpointError,
    answer,
    answerPermission,
  } = useCheckpointAnswering();

  // M11 row S1-19: one place decides where a remedy goes (`remedies.ts`).
  const onRemedy = (remedy: z.infer<typeof ErrorPayloadSchema>['remedy']): void =>
    followRemedy(remedy, {
      setActiveTab,
      openPath: (path) => void window.bureau.system.openPath({ path }),
    });

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
        {chat.hasOlder && (
          // P-4 / chaos #12: the conversation is loaded a page at a time. A
          // real button, first in the list, so it is reachable by keyboard and
          // announced; it says what it will do rather than being an infinite
          // scroll nobody can find with a screen reader.
          <li className="flex justify-center">
            <button
              type="button"
              onClick={showEarlier}
              disabled={chat.loadingOlder}
              className="rounded border border-bureau-border px-3 py-1 text-sm text-bureau-text-muted hover:text-bureau-text disabled:opacity-60"
            >
              {chat.loadingOlder ? 'Loading earlier messages…' : 'Show earlier messages'}
            </button>
          </li>
        )}
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
            onAnswer={(id, input) => {
              const target = checkpoints.find((c) => c.id === id);
              if (target !== undefined) void answer(target, input);
            }}
            onAnswerPermission={(id, allow) => {
              const target = checkpoints.find((c) => c.id === id);
              if (target !== undefined) void answerPermission(target, allow);
            }}
            onRemedy={onRemedy}
            onSendText={sendText}
            onDraft={fillComposer}
            onEditBrief={setEditingBrief}
            onSeen={markSeen}
          />
        ))}
      </ol>
      <PausedBanner />
      <ReviewerNotice />
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
