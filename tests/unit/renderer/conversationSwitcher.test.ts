import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ConversationSwitcher,
  chooseConversation,
} from '../../../src/renderer/src/components/chat/ConversationSwitcher';
import { emptyChatState, useBureauStore } from '../../../src/renderer/src/store/bureauStore';
import type { ConversationListItem } from '../../../src/shared/ipc/schemas/chat';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';

/**
 * M11 S2-1c, §K.2: the conversation switcher is a list — the company
 * conversation, then each project with its stage and an unread or waiting
 * marker (Nikunj's decision, 2026-09-25). The markers are the Core's; these
 * tests are about how the renderer shows them and which conversation it
 * opens.
 */
function item(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: 'c-company',
    company_id: 'co',
    project_id: null,
    title: 'Test Co',
    director_session_id: null,
    summary: null,
    director_state: null,
    director_state_data: null,
    status: 'active',
    created_at: '2026-09-25T09:00:00.000Z',
    updated_at: '2026-09-25T09:00:00.000Z',
    project: null,
    unreadCount: 0,
    waiting: false,
    lastMessageAt: null,
    ...overrides,
  } as ConversationListItem;
}

const company = item();
const trattoria = item({
  id: 'c-trattoria',
  project_id: 'p1',
  project: { id: 'p1', displayKey: 'P-001', name: 'Luigi Trattoria', stage: 'intake' },
  unreadCount: 3,
  lastMessageAt: '2026-09-25T10:00:00.000Z',
});
const pizzeria = item({
  id: 'c-pizzeria',
  project_id: 'p2',
  project: { id: 'p2', displayKey: 'P-002', name: 'Luigi Pizzeria', stage: 'brief' },
  waiting: true,
  unreadCount: 1,
  lastMessageAt: '2026-09-25T09:30:00.000Z',
});

const render = (items: ConversationListItem[], activeId: string | null) =>
  renderToStaticMarkup(
    createElement(ConversationSwitcher, { items, activeId, onSelect: () => {} }),
  );

describe('the conversation switcher', () => {
  it('is not shown while there is only one conversation', () => {
    expect(render([company], company.id)).toBe('');
  });

  it('lists the company conversation, then each project with its key and stage, in the order given', () => {
    const html = render([company, trattoria, pizzeria], trattoria.id);
    expect(html).toContain('aria-label="Conversations"');
    const order = ['Company', 'Luigi Trattoria', 'Luigi Pizzeria'].map((name) =>
      html.indexOf(name),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('P-001 · Understanding the request');
    expect(html).toContain('P-002 · Brief');
    // A list of buttons, the current one marked for assistive technology.
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="true"[^>]*>(?:(?!<\/button>).)*Luigi Trattoria/);
  });

  it('shows "waiting on you" where the user is waited on, and an unread count elsewhere', () => {
    const html = render([company, trattoria, pizzeria], company.id);
    expect(html).toContain('aria-label="3 unread"');
    expect(html).toContain('Waiting on you');
    // Waiting outranks unread: the pizzeria shows one marker, not two.
    expect(html).not.toContain('aria-label="1 unread"');
  });
});

describe('which conversation opens', () => {
  it('the one the user picked, while it exists', () => {
    expect(chooseConversation([company, trattoria, pizzeria], pizzeria.id)?.id).toBe(pizzeria.id);
  });

  it('otherwise the one where something was said last, not the newest conversation', () => {
    // The company conversation is the newest row (a project was just created
    // from it) and empty: opening it would move the user away mid-thought.
    const freshCompany = item({ id: 'c-fresh', created_at: '2026-09-25T11:00:00.000Z' });
    expect(chooseConversation([freshCompany, trattoria, pizzeria], null)?.id).toBe(trattoria.id);
    expect(chooseConversation([freshCompany, trattoria], 'c-gone')?.id).toBe(trattoria.id);
  });

  it('and the company conversation when nothing has been said anywhere', () => {
    const quiet = item({ ...trattoria, lastMessageAt: null });
    expect(chooseConversation([quiet, company], null)?.id).toBe(company.id);
  });
});

describe('the store says when the list may have changed', () => {
  const message = (overrides: Partial<ConversationMessage>): ConversationMessage =>
    ({
      id: 'm1',
      conversation_id: 'c-trattoria',
      project_id: null,
      author: 'director',
      kind: 'text',
      body: 'hello',
      payload: null,
      checkpoint_id: null,
      status: 'complete',
      seq: null,
      read_at: null,
      created_at: '2026-09-25T10:00:00.000Z',
      updated_at: '2026-09-25T10:00:00.000Z',
      ...overrides,
    }) as ConversationMessage;

  beforeEach(() => {
    useBureauStore.setState({
      conversationListEpoch: 0,
      chat: { ...emptyChatState(), conversationId: 'c-trattoria', status: 'ready' },
    });
  });

  it('on a message in another conversation, and on a new message in this one; not on an update', () => {
    const store = useBureauStore.getState();
    store.applyChatMessage(1, message({ id: 'm-other', conversation_id: 'c-pizzeria' }));
    expect(useBureauStore.getState().conversationListEpoch).toBe(1);
    store.applyChatMessage(2, message({ id: 'm1', status: 'streaming' }));
    expect(useBureauStore.getState().conversationListEpoch).toBe(2);
    store.applyChatMessage(3, message({ id: 'm1', status: 'complete' }));
    expect(useBureauStore.getState().conversationListEpoch).toBe(2);
  });

  it('and the chat view re-reads the list on it', () => {
    const source = readFileSync(
      path.resolve('src/renderer/src/components/chat/ChatView.tsx'),
      'utf8',
    );
    expect(source).toMatch(/\}, \[hydrationEpoch, conversationListEpoch\]\);/);
    expect(source).toMatch(/<ConversationSwitcher/);
  });
});
