import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionBubble } from '../../../src/renderer/src/components/chat/kinds';
import { QuestionPayloadSchema } from '../../../src/shared/models/chatPayloads';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';

/**
 * M11 S2-2a, decision E-6: intake's batch renders with M9's question chips —
 * every question with its options as real buttons, the recommended one
 * marked and its reason shown, and one "You decide" for the batch.
 */
const batch = {
  questions: [
    {
      id: 'booking',
      text: 'How should diners book a table?',
      options: [
        { id: 'phone', label: 'By phone' },
        { id: 'online', label: 'Online' },
      ],
      recommendation: { optionId: 'phone', why: 'Nothing to build, and it is how you work today.' },
    },
    {
      id: 'menu',
      text: 'Should the menu be on the site?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      recommendation: { optionId: 'yes', why: 'It is what most visitors look for first.' },
    },
  ],
};

const message = (payload: unknown): ConversationMessage =>
  ({
    id: 'm1',
    conversation_id: 'c1',
    project_id: null,
    author: 'director',
    kind: 'question',
    body: 'Two questions before I write the brief.',
    payload,
    checkpoint_id: null,
    status: 'complete',
    seq: null,
    read_at: null,
    created_at: '2026-09-25T10:00:00.000Z',
    updated_at: '2026-09-25T10:00:00.000Z',
  }) as ConversationMessage;

describe("intake's question batch", () => {
  it('renders each question with its chips, the recommendation marked with its reason, and "You decide"', () => {
    const html = renderToStaticMarkup(
      createElement(QuestionBubble, { message: message(batch), onAnswer: () => {} }),
    );
    expect(html).toContain('How should diners book a table?');
    expect(html).toContain('Should the menu be on the site?');
    expect(html.match(/<button/g)).toHaveLength(5); // two chips each, and "You decide"
    expect(html.match(/Recommended/g)).toHaveLength(2);
    expect(html).toContain('Nothing to build, and it is how you work today.');
    expect(html).toContain('You decide');
  });

  it('still renders M9’s single question with chips', () => {
    const html = renderToStaticMarkup(
      createElement(QuestionBubble, {
        message: message({ options: [{ id: 'a', label: 'Just me' }] }),
        onAnswer: () => {},
      }),
    );
    expect(html).toContain('Just me');
    expect(html).not.toContain('You decide');
  });

  it('refuses a recommendation that names no option', () => {
    const broken = structuredClone(batch);
    broken.questions[0]!.recommendation.optionId = 'carrier-pigeon';
    expect(QuestionPayloadSchema.safeParse(broken).success).toBe(false);
  });
});
