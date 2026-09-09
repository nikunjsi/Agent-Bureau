import { describe, expect, it } from 'vitest';
import {
  isSafeHref,
  parseInline,
  parseMarkdown,
} from '../../../src/renderer/src/components/chat/markdownParser';

/**
 * The hand-rolled markdown subset (§14.2's "Markdown bubble").
 *
 * The security case is the reason this is hand-rolled rather than a
 * dependency: message bodies are agent-authored, and every mainstream
 * markdown library produces an HTML string that then needs sanitising.
 * Producing nodes means there is no HTML string to sanitise — but the link
 * scheme still has to be checked, because a link is the one place where
 * the source text becomes an instruction to the browser.
 */
describe('markdown subset', () => {
  it('renders a javascript: link as text, showing where it pointed', () => {
    const inline = parseInline('[click me](javascript:alert(1))');
    // The branch that matters, asserted directly: no node in the result is
    // a link. That is a stronger statement than "the text looks right",
    // and it is the one that decides whether a click can execute anything.
    expect(inline.some((node) => node.kind === 'link')).toBe(false);
    // And the destination is shown rather than swallowed, so a reader can
    // see what the message was trying to get them to click.
    const text = inline.map((node) => ('text' in node ? node.text : '')).join('');
    expect(text).toContain('click me');
    expect(text).toContain('javascript:alert(1');
  });

  it('accepts http and https and nothing else', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
    expect(isSafeHref('  HTTPS://EXAMPLE.COM  ')).toBe(true);
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>',
      'file:///c:/windows',
      'app://bureau/index.html',
      '/relative',
      'vbscript:msgbox',
    ]) {
      expect(isSafeHref(href), `${href} must not be a link`).toBe(false);
    }
  });

  it('keeps markdown inside inline code literal', () => {
    expect(parseInline('use `**not bold**` here')).toEqual([
      { kind: 'text', text: 'use ' },
      { kind: 'code', text: '**not bold**' },
      { kind: 'text', text: ' here' },
    ]);
  });

  it('parses the blocks §14.2 actually needs', () => {
    const blocks = parseMarkdown(
      [
        '# Heading',
        '',
        'A paragraph with **bold**.',
        '',
        '- one',
        '- two',
        '',
        '```ts',
        'const x = 1;',
        '```',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'code']);
    const list = blocks[2];
    expect(list?.kind === 'list' && list.items).toHaveLength(2);
    const code = blocks[3];
    expect(code?.kind === 'code' && code.language).toBe('ts');
    expect(code?.kind === 'code' && code.text).toBe('const x = 1;');
  });

  it('shows the code in an unterminated fence rather than the backticks', () => {
    // A stream cut off mid-code-block is a normal case here, not an edge
    // one — `aborted` messages are a state this product renders on purpose.
    const blocks = parseMarkdown('```\nhalf a func');
    expect(blocks).toEqual([{ kind: 'code', language: null, text: 'half a func' }]);
  });

  it('renders an unsupported construct as its literal text rather than dropping it', () => {
    // Tables are not supported (docs/NEXT-VERSION.md §C). The failure mode
    // that would matter is silently losing the content; showing the source
    // is ugly and complete.
    const blocks = parseMarkdown('| a | b |\n| - | - |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('paragraph');
    const paragraph = blocks[0];
    const text =
      paragraph?.kind === 'paragraph'
        ? paragraph.content.map((node) => ('text' in node ? node.text : '')).join('')
        : '';
    expect(text).toContain('| a | b |');
  });
});
