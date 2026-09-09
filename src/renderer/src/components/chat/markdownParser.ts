/**
 * A deliberately small markdown subset, tokenised to a data structure the
 * renderer turns into React elements.
 *
 * ## Why not a markdown library
 *
 * Every mainstream one produces an HTML string, which means
 * `dangerouslySetInnerHTML` and a sanitiser to go with it. The content here
 * is agent-authored free text — the least trustworthy content in the
 * product — so that would be adding an HTML-injection surface at exactly
 * the wrong place, plus two dependencies and their licences (invariant
 * #14's neighbourhood). Producing nodes instead means there is no HTML
 * string anywhere in the path and nothing to sanitise.
 *
 * ## What it does not do
 *
 * Tables, images, blockquotes, nested lists, and reference links render as
 * their literal source text. That is a real limitation — Director-authored
 * prose will contain tables — and it is logged as an accepted one in
 * docs/NEXT-VERSION.md §C rather than left to be discovered.
 *
 * ## Links
 *
 * Only `http:` and `https:` become links. Anything else — `javascript:`
 * above all — renders as plain text, and the URL is shown rather than
 * hidden behind the label, so a link's destination is never a surprise.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; content: Inline[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'list'; ordered: boolean; items: Inline[][] };

const FENCE = /^```(\w*)\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const UNORDERED = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const language = fence[1] === undefined || fence[1] === '' ? null : fence[1];
      const body: string[] = [];
      i += 1;
      // An unterminated fence takes the rest of the message rather than
      // being abandoned: a stream that is cut off mid-code-block is a real
      // and expected case here, and showing the code is better than
      // showing the backticks.
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'code', language, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: 'heading',
        level: (heading[1]?.length ?? 1) as 1 | 2 | 3,
        content: parseInline(heading[2] ?? ''),
      });
      continue;
    }

    const unordered = UNORDERED.exec(line);
    const ordered = ORDERED.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null && unordered === null;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const match = isOrdered ? ORDERED.exec(current) : UNORDERED.exec(current);
        if (!match) break;
        items.push(parseInline(match[1] ?? ''));
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

/** `[label](href)`, `` `code` ``, `**strong**`, `*em*` / `_em_`. Scanned in
 * one pass so a `**bold**` inside backticks stays literal. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const pushPlain = (): void => {
    if (plain.length > 0) out.push({ kind: 'text', text: plain });
    plain = '';
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      pushPlain();
      out.push({ kind: 'code', text: code[1] ?? '' });
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      pushPlain();
      const label = link[1] ?? '';
      const href = link[2] ?? '';
      if (isSafeHref(href)) {
        out.push({ kind: 'link', text: label.length > 0 ? label : href, href });
      } else {
        // Not a link, and not silently dropped either: the user sees
        // exactly what the text said, destination included.
        out.push({ kind: 'text', text: `${label} (${href})` });
      }
      i += link[0].length;
      continue;
    }

    const strong = /^\*\*([^*]+)\*\*/.exec(rest);
    if (strong) {
      pushPlain();
      out.push({ kind: 'strong', text: strong[1] ?? '' });
      i += strong[0].length;
      continue;
    }

    const em = /^(?:\*([^*]+)\*|_([^_]+)_)/.exec(rest);
    if (em) {
      pushPlain();
      out.push({ kind: 'em', text: em[1] ?? em[2] ?? '' });
      i += em[0].length;
      continue;
    }

    plain += source[i];
    i += 1;
  }
  pushPlain();
  return out;
}

/**
 * `http`/`https` only. Everything else — `javascript:`, `data:`, `file:`,
 * and any scheme invented later — is not a link. An allow-list, because a
 * deny-list of dangerous schemes is a list someone eventually gets wrong.
 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}
