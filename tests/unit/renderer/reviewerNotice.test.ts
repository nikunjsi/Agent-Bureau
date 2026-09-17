import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewerNotice } from '../../../src/renderer/src/components/chat/ReviewerNotice';

/**
 * P-8 / risk #35: "the user believes Bureau is responsible for agent output".
 * The chat surface says, in plain language, that the user is the final
 * reviewer of what employees produce. Presentation lives in the renderer.
 */
describe('the chat says the user is the final reviewer (P-8, risk #35)', () => {
  it('renders plain-language copy naming the user as the final reviewer', () => {
    const html = renderToStaticMarkup(createElement(ReviewerNotice));
    expect(html).toContain('You are the final reviewer');
    expect(html).toMatch(/can make mistakes/i);
    // Plain language (Appendix C): no internals, no jargon.
    expect(html).not.toMatch(/agent|LLM|model|§/);
  });

  it('is rendered by the chat view, beside the composer', () => {
    const source = readFileSync(
      path.resolve('src/renderer/src/components/chat/ChatView.tsx'),
      'utf8',
    );
    expect(source).toMatch(/<ReviewerNotice \/>\s*<Composer/);
  });
});
