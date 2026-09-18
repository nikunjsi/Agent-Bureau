import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MemoryItemLabel,
  isEditableByUser,
} from '../../../src/renderer/src/components/memory/MemoryView';
import type { Memory } from '../../../src/shared/models/memory';

function note(overrides: Partial<Memory> = {}): Memory {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    scope: 'company',
    scope_ref: null,
    path: 'company/standards.md',
    title: 'Standards',
    body: '# Standards',
    tags: [],
    source: 'user_stated',
    pinned: false,
    content_sha256: 'x'.repeat(64),
    mtime_ms: 0,
    size_bytes: 12,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Memory;
}

/**
 * X-17 / §14.7: "never colour alone" — icon **and** label. A pinned note had
 * a pin emoji and an `sr-only` "(pinned)", which passes a screen reader and
 * fails a sighted one: a pictogram, and nothing naming it, for the property
 * that decides whether employees read the note on every task (§12.3).
 */
describe('the memory list labels a pinned note visibly (X-17)', () => {
  it('renders the word Pinned, not only the icon', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryItemLabel, { item: note({ pinned: true }) }),
    );

    expect(html).toContain('Pinned');
    // Visible: the word is not inside the screen-reader-only class, which is
    // exactly what this row was about.
    expect(html).not.toMatch(/sr-only[^>]*>\s*(\(pinned\)|Pinned)/i);
    expect(html).toContain('aria-hidden="true"');
  });

  it('says nothing about pinning for a note that is not pinned', () => {
    const html = renderToStaticMarkup(createElement(MemoryItemLabel, { item: note() }));

    expect(html).not.toMatch(/pinned/i);
    expect(html).toContain('Standards');
  });
});

/**
 * X-18 / §14.9: the view offered Edit, Pin and Delete on an `employee/` note,
 * and the Core refuses every one of them — `employee/` is an individual's
 * notebook, and a person using the UI is not that employee. Three buttons
 * that always fail.
 */
describe('an employee’s own notebook is read-only from the memory view (X-18)', () => {
  it('is not editable by the user', () => {
    expect(isEditableByUser(note({ scope: 'employee', path: 'employee/emp-1/notes.md' }))).toBe(
      false,
    );
  });

  it('leaves every other scope editable', () => {
    for (const scope of ['company', 'project', 'role', 'user'] as const) {
      expect(isEditableByUser(note({ scope })), scope).toBe(true);
    }
  });
});
