import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageRow } from '../../../src/renderer/src/components/chat/MessageRow';
import { checkpointsNamedBy } from '../../../src/renderer/src/components/chat/kinds';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';
import type { Checkpoint } from '../../../src/shared/models/checkpoint';

/**
 * M11 S2-6, §9.3: a grouped report names its checkpoints, and each one still
 * pending is answered on its own card under the report — from the
 * `checkpoints` slice, never from a copy in the message (§9.4).
 */
const ids = [
  '01M3AAAAAAAAAAAAAAAAAAAAAA',
  '01M3BBBBBBBBBBBBBBBBBBBBBB',
  '01M3CCCCCCCCCCCCCCCCCCCCCC',
];

const checkpoint = (id: string, title: string): Checkpoint =>
  ({
    id,
    project_id: null,
    task_id: null,
    employee_id: null,
    type: 'decision',
    urgency: 'soon',
    tool_call_id: null,
    tool_name: null,
    args_preview: null,
    title,
    context: 'Either is fine.',
    options: [
      { id: 'a', label: 'The first', consequence: 'The first is used.', reversible: true },
      { id: 'b', label: 'The second', consequence: 'The second is used.', reversible: true },
    ],
    preview: null,
    default_action: 'a',
    status: 'pending',
    answer: null,
    answered_at: null,
    expires_at: null,
    created_at: '2026-09-25T10:00:00.000Z',
    updated_at: '2026-09-25T10:00:00.000Z',
  }) as unknown as Checkpoint;

const report = (checkpointIds: string[]): ConversationMessage =>
  ({
    id: 'm1',
    conversation_id: 'c1',
    project_id: null,
    author: 'director',
    kind: 'report',
    body: 'Three small choices are waiting for you.',
    payload: { whatHappened: 'Three small choices came up.', checkpointIds },
    checkpoint_id: null,
    status: 'complete',
    seq: null,
    read_at: null,
    created_at: '2026-09-25T10:00:00.000Z',
    updated_at: '2026-09-25T10:00:00.000Z',
  }) as ConversationMessage;

// The third was answered: it has left the pending slice.
const pending = [checkpoint(ids[1]!, 'Font'), checkpoint(ids[0]!, 'Header colour')];

describe('a report that groups checkpoints', () => {
  it('names the pending ones, in the report’s order, and not an answered one', () => {
    expect(checkpointsNamedBy(report(ids), pending).map((c) => c.title)).toEqual([
      'Header colour',
      'Font',
    ]);
  });

  it('names nothing for a report without checkpoints, or another kind of message', () => {
    expect(checkpointsNamedBy(report([]), pending)).toEqual([]);
    expect(checkpointsNamedBy({ ...report(ids), kind: 'text', payload: null }, pending)).toEqual(
      [],
    );
  });

  it('renders the report, then one answerable card per pending checkpoint', () => {
    const message = report(ids);
    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message,
        checkpoint: null,
        groupedCheckpoints: checkpointsNamedBy(message, pending),
        submittingCheckpointId: null,
        checkpointError: null,
        onAnswer: () => {},
        onAnswerPermission: () => {},
        onRemedy: () => {},
        onSendText: () => {},
        onDraft: () => {},
        onEditBrief: () => {},
        onSeen: () => {},
      }),
    );
    expect(html).toContain('Three small choices came up.');
    expect(html).toContain('Decision: Header colour');
    expect(html).toContain('Decision: Font');
    expect(html.indexOf('Decision: Header colour')).toBeLessThan(html.indexOf('Decision: Font'));
    expect(html.match(/aria-label="Decision: /g)).toHaveLength(2);
  });
});
