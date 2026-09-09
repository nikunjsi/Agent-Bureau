import { describe, expect, it, beforeEach } from 'vitest';
import { emptyChatState, useBureauStore } from '../../../src/renderer/src/store/bureauStore';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';

/**
 * The chat slice's two rules, as a pure reducer — no Electron, no IPC.
 * The real path (a real packaged app, real pushes, real rendering) is
 * `tests/e2e/chat.spec.ts`; this is the fast complement that pins the
 * recovery behaviour case by case, which a browser launch per case cannot.
 */

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

  const ready = (messages: ConversationMessage[], lastChannelSeq: number | null = null): void => {
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
      .hydrateChat('c1', [message({ id: 'm1' }), message({ id: 'm2', body: 'from the list' })]);

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
    useBureauStore.getState().hydrateChat('c1', [message({ id: 'kept' })]);
    expect(useBureauStore.getState().chat.messages.map((m) => m.id)).toEqual(['kept']);
  });

  it('a response for a conversation the user has left does not overwrite the one on screen', () => {
    ready([message({ id: 'current' })]);
    useBureauStore.getState().hydrateChat('c-old', [message({ id: 'stale' })]);
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
});
