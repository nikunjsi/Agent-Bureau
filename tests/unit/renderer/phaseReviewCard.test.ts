import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SummaryCard } from '../../../src/renderer/src/components/chat/kinds';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';

/**
 * M11 S3-5a, §8.6: the phase-review card lists what was verified, what was
 * **not**, and the known issues, and offers the user's decision. Without a
 * phase it is §14.2's plain phase-completion card, as before.
 */
const message = (payload: unknown): ConversationMessage =>
  ({
    id: 'm1',
    conversation_id: 'c1',
    project_id: null,
    author: 'director',
    kind: 'summary',
    body: 'The menu page is up.',
    payload,
    checkpoint_id: null,
    status: 'complete',
    seq: null,
    read_at: null,
    created_at: '2026-09-25T10:00:00.000Z',
    updated_at: '2026-09-25T10:00:00.000Z',
  }) as ConversationMessage;

describe('the phase-review card', () => {
  it('shows what was verified, what was not, the known issues, and the accept button', () => {
    const html = renderToStaticMarkup(
      createElement(SummaryCard, {
        message: message({
          phaseName: 'Menu',
          phaseId: '01M3AAAAAAAAAAAAAAAAAAAAAA',
          verified: ['menu.html opens'],
          notVerified: ['prices against the printed menu'],
          knownIssues: ['Prices change on Mondays.'],
        }),
      }),
    );
    expect(html).toContain('Verified');
    expect(html).toContain('menu.html opens');
    expect(html).toContain('Not verified');
    expect(html).toContain('prices against the printed menu');
    expect(html).toContain('Known issues');
    expect(html).toContain('Accept this phase');
  });

  it('a plain phase-completion card has no decision to make', () => {
    const html = renderToStaticMarkup(
      createElement(SummaryCard, { message: message({ phaseName: 'Menu' }) }),
    );
    expect(html).toContain('Menu — complete');
    expect(html).not.toContain('Accept this phase');
    expect(html).not.toContain('Not verified');
  });
});
