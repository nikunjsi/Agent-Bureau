import { describe, expect, it, beforeEach } from 'vitest';
import {
  emptyChatState,
  selectChatUnreadCount,
  useBureauStore,
} from '../../../src/renderer/src/store/bureauStore';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';

/**
 * The chat slice's two rules, as a pure reducer — no Electron, no IPC.
 * The real path (a real packaged app, real pushes, real rendering) is
 * `tests/e2e/chat.spec.ts`; this is the fast complement that pins the
 * recovery behaviour case by case, which a browser launch per case cannot.
 */

const NO_OLDER = { hasOlder: false, unreadOlderCount: 0 };

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'm1',
    conversation_id: 'c1',
    project_id: null,
    author: 'director',
    kind: 'text',
    body: 'hello',
    payload: null,
    checkpoint_id: null,
    status: 'complete',
    seq: null,
    read_at: null,
    created_at: '2026-09-09T10:00:00.000Z',
    updated_at: '2026-09-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('bureauStore chat slice', () => {
  beforeEach(() => {
    useBureauStore.setState({ chat: emptyChatState() });
  });

  const ready = (messages: ConversationMessage[], lastChannelSeq = 0): void => {
    useBureauStore.setState({
      chat: {
        ...emptyChatState(),
        conversationId: 'c1',
        messages,
        status: 'ready',
        lastChannelSeq,
      },
    });
  };

  it('a pushed update replaces the row it names rather than appending a second copy', () => {
    ready([message({ body: 'par', status: 'streaming' })]);
    useBureauStore
      .getState()
      .applyChatMessage(1, message({ body: 'partial', status: 'streaming' }));

    const chat = useBureauStore.getState().chat;
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]?.body).toBe('partial');
    expect(chat.messages[0]?.status).toBe('streaming');
  });

  it('a freshly loaded window expects seq 1 — a first push that is not seq 1 is a gap', () => {
    // The baseline the store starts at, and the one it returns to on a
    // reload. It is 0, not "unknown", because the main process restarts
    // this window's channel counter at 0 on the same `did-finish-load`
    // that re-creates this store.
    useBureauStore.setState({
      chat: { ...emptyChatState(), conversationId: 'c1', status: 'ready' },
    });

    // seq 1 was dropped. Under the old `null` baseline this was adopted
    // silently — one undetectable lost push after every single load, at
    // exactly the moment this session proved pushes do go missing.
    const needsResync = useBureauStore.getState().applyChatMessage(2, message({ id: 'm2' }));
    expect(needsResync, 'a first push of seq 2 means seq 1 was lost').toBe(true);
    expect(useBureauStore.getState().chat.messages).toHaveLength(0);
  });

  it('the first push after a load applies when it really is seq 1', () => {
    // The negative control for the case above: a correct first push must
    // not be mistaken for a gap, or every window load would re-fetch.
    useBureauStore.setState({
      chat: { ...emptyChatState(), conversationId: 'c1', status: 'ready' },
    });
    const needsResync = useBureauStore.getState().applyChatMessage(1, message({ id: 'm1' }));
    expect(needsResync).toBe(false);
    expect(useBureauStore.getState().chat.messages.map((m) => m.id)).toEqual(['m1']);
    expect(useBureauStore.getState().chat.lastChannelSeq).toBe(1);
  });

  it('a re-fetch does not reset the window channel baseline', () => {
    // The sequence belongs to the window's chat channel, not to a
    // conversation. A re-fetch that reset it would either miss the next
    // dropped push, or (as here) invent a gap that never happened.
    ready([message({ id: 'm1' })], 12);
    useBureauStore.getState().beginChatLoad('c1');
    useBureauStore.getState().hydrateChat('c1', [message({ id: 'm1' })], NO_OLDER);
    expect(useBureauStore.getState().chat.lastChannelSeq).toBe(12);

    const needsResync = useBureauStore.getState().applyChatMessage(13, message({ id: 'm2' }));
    expect(needsResync, 'seq 13 follows 12 — this is not a gap').toBe(false);
    expect(useBureauStore.getState().chat.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('a message for another conversation is not applied, but its sequence still counts', () => {
    ready([], 4);
    const needsResync = useBureauStore
      .getState()
      .applyChatMessage(5, message({ id: 'other', conversation_id: 'c2' }));

    const chat = useBureauStore.getState().chat;
    expect(needsResync).toBe(false);
    expect(chat.messages).toHaveLength(0);
    // The branch that matters: consuming the sequence. Dropping it would
    // manufacture a gap on the next message that IS ours, and send the
    // view into a re-fetch it never needed.
    expect(chat.lastChannelSeq).toBe(5);
  });

  it('a sequence gap asks for a re-fetch instead of applying what it cannot place', () => {
    ready([message({ id: 'm1' })], 7);
    const needsResync = useBureauStore.getState().applyChatMessage(9, message({ id: 'm2' }));

    const chat = useBureauStore.getState().chat;
    expect(needsResync).toBe(true);
    expect(chat.resyncing).toBe(true);
    expect(chat.status).toBe('resyncing');
    // Not applied — and not thrown away either.
    expect(chat.messages.map((m) => m.id)).toEqual(['m1']);
    expect(chat.buffered).toHaveLength(1);
  });

  it('pushes that arrive during a re-fetch are replayed on top of its answer', () => {
    ready([message({ id: 'm1' })], 7);
    // The real order the ipcBridge produces: a gap is detected, and the
    // re-fetch it asks for begins — `beginChatLoad` must not throw away the
    // message that revealed the gap.
    useBureauStore.getState().applyChatMessage(9, message({ id: 'm3', body: 'pushed late' }));
    useBureauStore.getState().beginChatLoad('c1');
    expect(
      useBureauStore.getState().chat.buffered,
      'the message that triggered the re-fetch must survive it',
    ).toHaveLength(1);
    // A second one, arriving while the request is still in flight.
    useBureauStore
      .getState()
      .applyChatMessage(10, message({ id: 'm4', created_at: '2026-09-09T10:00:02.000Z' }));

    // The Core's answer, which predates both pushes.
    useBureauStore
      .getState()
      .hydrateChat(
        'c1',
        [message({ id: 'm1' }), message({ id: 'm2', body: 'from the list' })],
        NO_OLDER,
      );

    const chat = useBureauStore.getState().chat;
    expect(chat.status).toBe('ready');
    expect(chat.resyncing).toBe(false);
    expect(chat.buffered).toHaveLength(0);
    expect(chat.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    // The sequence baseline moves to the newest replayed push, so the next
    // one is judged against the right number.
    expect(chat.lastChannelSeq).toBe(10);
  });

  it('hydrating replaces the list — it never merges what the Core no longer has', () => {
    ready([message({ id: 'gone' }), message({ id: 'also-gone' })]);
    useBureauStore.getState().hydrateChat('c1', [message({ id: 'kept' })], NO_OLDER);
    expect(useBureauStore.getState().chat.messages.map((m) => m.id)).toEqual(['kept']);
  });

  it('a response for a conversation the user has left does not overwrite the one on screen', () => {
    ready([message({ id: 'current' })]);
    useBureauStore.getState().hydrateChat('c-old', [message({ id: 'stale' })], NO_OLDER);
    expect(useBureauStore.getState().chat.messages.map((m) => m.id)).toEqual(['current']);
  });

  it('a full stateDelta bumps the hydration epoch the chat view re-fetches on', () => {
    const before = useBureauStore.getState().hydrationEpoch;
    useBureauStore.getState().applyDelta({
      kind: 'full',
      seq: 1,
      slices: {
        settings: {},
        company: null,
        projects: [],
        tasks: [],
        employees: [],
        checkpoints: [],
      },
    });
    expect(useBureauStore.getState().hydrationEpoch).toBe(before + 1);
  });

  // P-4: `chat.listMessages` returns a page, so the store tracks whether older
  // messages exist and how many of them are unread, and the badge adds that
  // Core-computed count to the loaded messages the shared predicate counts.
  describe('pagination (P-4)', () => {
    const at = (second: number): string =>
      new Date(Date.parse('2026-09-09T10:00:00.000Z') + second * 1000).toISOString();

    it('hydrate records the page facts, and the badge counts unread older messages it has not loaded', () => {
      useBureauStore.getState().beginChatLoad('c1');
      useBureauStore
        .getState()
        .hydrateChat(
          'c1',
          [
            message({ id: 'm10', created_at: at(10) }),
            message({ id: 'm11', created_at: at(11), read_at: at(12) }),
          ],
          { hasOlder: true, unreadOlderCount: 7 },
        );
      const state = useBureauStore.getState();
      expect(state.chat.hasOlder).toBe(true);
      expect(selectChatUnreadCount(state)).toBe(8); // 7 older + m10
    });

    it('prepending an older page merges in order, replaces the page facts, and the badge does not double-count', () => {
      useBureauStore.getState().beginChatLoad('c1');
      useBureauStore.getState().hydrateChat('c1', [message({ id: 'm10', created_at: at(10) })], {
        hasOlder: true,
        unreadOlderCount: 2,
      });
      useBureauStore
        .getState()
        .prependOlderChat(
          'c1',
          [
            message({ id: 'm1', created_at: at(1) }),
            message({ id: 'm2', created_at: at(2), author: 'user' }),
            message({ id: 'm3', created_at: at(3) }),
          ],
          { hasOlder: false, unreadOlderCount: 0 },
        );
      const state = useBureauStore.getState();
      expect(state.chat.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm10']);
      expect(state.chat.hasOlder).toBe(false);
      // The two older unread (m1, m3) are now loaded and counted once.
      expect(selectChatUnreadCount(state)).toBe(3);
    });

    it('an older page for a conversation no longer on screen is ignored', () => {
      useBureauStore.getState().beginChatLoad('c1');
      useBureauStore.getState().hydrateChat('c1', [message({ id: 'm10', created_at: at(10) })], {
        hasOlder: true,
        unreadOlderCount: 1,
      });
      useBureauStore
        .getState()
        .prependOlderChat('c-old', [message({ id: 'x', conversation_id: 'c-old' })], {
          hasOlder: false,
          unreadOlderCount: 0,
        });
      expect(useBureauStore.getState().chat.messages.map((m) => m.id)).toEqual(['m10']);
      expect(useBureauStore.getState().chat.hasOlder).toBe(true);
    });
  });
});
