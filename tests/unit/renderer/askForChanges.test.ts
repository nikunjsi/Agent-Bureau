import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefCard, PlanCard } from '../../../src/renderer/src/components/chat/kinds';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';

/**
 * M11 S2-3b: "Ask for changes" on the brief and plan cards is the
 * production caller of `brief.requestEdit` / `plan.requestEdit` (standing
 * rule 2). The brief keeps its own Edit — the user rewriting the markdown —
 * beside it; the plan, which has no text of its own, has only this.
 */
const message = (kind: 'brief' | 'plan', payload: unknown): ConversationMessage =>
  ({
    id: 'm1',
    conversation_id: 'c1',
    project_id: null,
    author: 'director',
    kind,
    body: '',
    payload,
    checkpoint_id: null,
    status: 'complete',
    seq: null,
    read_at: null,
    created_at: '2026-09-25T10:00:00.000Z',
    updated_at: '2026-09-25T10:00:00.000Z',
  }) as ConversationMessage;

const props = { onDiscuss: () => {}, onEditBrief: () => {} };

describe('"Ask for changes" on the document cards', () => {
  it('the brief card offers Approve, Edit, Ask for changes and Discuss', () => {
    const html = renderToStaticMarkup(
      createElement(BriefCard, {
        ...props,
        message: message('brief', {
          briefId: null,
          title: 'Luigi Trattoria',
          goal: 'Diners call to book.',
        }),
      }),
    );
    for (const label of ['Approve', 'Edit', 'Ask for changes', 'Discuss']) {
      expect(html).toContain(`>${label}</button>`);
    }
  });

  it('the plan card offers Ask for changes and no text editor', () => {
    const html = renderToStaticMarkup(
      createElement(PlanCard, {
        ...props,
        message: message('plan', {
          planId: null,
          phases: [],
          estimatedCostMicros: null,
          hiresNeeded: [],
        }),
      }),
    );
    expect(html).toContain('>Ask for changes</button>');
    expect(html).not.toContain('>Edit</button>');
  });

  it('each card sends the request through its own requestEdit', () => {
    const source = readFileSync(path.resolve('src/renderer/src/components/chat/kinds.tsx'), 'utf8');
    expect(source).toMatch(/window\.bureau\.brief\.requestEdit\(\{ id: targetId, feedback \}\)/);
    expect(source).toMatch(/window\.bureau\.plan\.requestEdit\(\{ id: targetId, feedback \}\)/);
  });
});
