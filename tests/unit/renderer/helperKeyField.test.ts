import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HelperKeyStatus,
  HELPER_KEY_NAME,
  HELPER_KEY_PROMPT,
} from '../../../src/renderer/src/components/HelperKeyField';
import { API_KEY_HONEST_NOTE } from '../../../src/main/secrets/secretStore';
import { ONESHOT_SECRET_KEY_NAME } from '../../../src/main/ai/oneshotConfig';

/**
 * X-20 / §22.4: *"Settings offers 'Add a key for small helper tasks (optional
 * — a few cents a month)' with an honest note on what improves."*
 *
 * The IPC seams have existed since M6 — `settings.setSecret`, `clearSecret`
 * and `getSecretsStatus`, which returns Bureau's real honest note — and no
 * renderer called any of them, so the key could only be set by someone
 * editing the database. A feature documented as optional and reachable by
 * nobody is not optional.
 */
describe('Settings offers the helper key, honestly (X-20)', () => {
  it('names the key the one-shot client actually reads', () => {
    // Two constants for one name is how the field ends up writing a key
    // nothing looks for.
    expect(HELPER_KEY_NAME).toBe(ONESHOT_SECRET_KEY_NAME);
  });

  it('shows §22.4’s offer, what improves, and Bureau’s own honest note', () => {
    const html = renderToStaticMarkup(
      createElement(HelperKeyStatus, { status: null, note: API_KEY_HONEST_NOTE }),
    );

    expect(html).toContain(HELPER_KEY_PROMPT);
    expect(HELPER_KEY_PROMPT).toBe(
      'Add a key for small helper tasks (optional — a few cents a month)',
    );
    // "with an honest note on what improves" — both halves: what Bureau
    // does with a key, and what it does without one.
    expect(html).toMatch(/Bureau works without this/);
    expect(html).toMatch(/falls back to keyword matching/);
    // The note is the Core's, not a paraphrase written here.
    expect(html).toContain('long-lived and cannot be scoped down');
    expect(html).toContain('No key stored.');
  });

  it('says a key is stored without ever showing one', () => {
    const html = renderToStaticMarkup(
      createElement(HelperKeyStatus, {
        status: { key: HELPER_KEY_NAME, provider: 'anthropic', lastSetAt: '2026-09-18T10:00:00Z' },
        note: API_KEY_HONEST_NOTE,
      }),
    );

    expect(html).toContain('A key is stored (set 2026-09-18)');
    expect(html).toMatch(/never shows it again/);
    // §11.4: no secret value is ever read back over IPC, so there is
    // nothing here that could render one — asserted, not assumed.
    expect(html).not.toMatch(/sk-|api[_-]?key["']?\s*[:=]/i);
  });
});
