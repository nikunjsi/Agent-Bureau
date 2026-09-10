import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * AUDIT M0–M2 #10 — §14.7 requires "WCAG AA contrast in both themes", and
 * §28's M2 item 6 claimed it was "verified on both". **Nothing verified
 * anything**: a grep of `tests/` for `contrast`, `wcag` and `axe` returned
 * nothing at all, and six live token pairings were below AA in the shipped
 * palette — light `text-muted` on `bg-elevated` at 4.40:1 being the one
 * every inactive tab in the app was rendered with.
 *
 * ## Why this file is the durable half of the fix
 *
 * Changing four hex values fixes today. This is the same class of gap
 * session 1 named and closed for pragmas and compiler flags: **nothing in
 * this repository asserted that a configuration was in force.** A colour
 * token is exactly that — a declaration, not a behaviour. No code fails
 * when a token drifts, so a green CI is not evidence of anything, and the
 * damage never appears in the diff that causes it.
 *
 * ## What it reads, and what it refuses to restate
 *
 * The values come from `theme.css` itself, parsed. A test carrying its own
 * copy of the palette would assert that the copy is accessible and say
 * nothing whatsoever about what ships (standing rule 1). The token *names*
 * come from the components, by scanning for the Tailwind classes that
 * actually appear in them.
 *
 * The one hand-written part is `SURFACE_MODEL` — which background each
 * text token can land on — because resolving that mechanically needs real
 * ancestry resolution through JSX, and a resolver that got it wrong would
 * make this test lie in the direction of passing. So it is a list, and the
 * list is not trusted: `covers exactly the tokens the components use`
 * below fails if a component introduces a token the model does not name,
 * **and** if the model names one no component uses. A model entry cannot
 * go quietly stale, which is the property that made the `rawSqlWritesAreOwned`
 * allowlist safe (AUDIT #4).
 *
 * A first draft derived the pairings purely by co-occurrence inside one
 * `className` string, and it was wrong in a way worth recording: template
 * literals hold mutually exclusive ternary branches, so it cheerfully
 * paired `text-bureau-accent-text` with `bg-bureau-bg` (1.00:1) — a
 * combination no element can ever have. A test that fails on impossible
 * pairings gets its threshold lowered until it is quiet.
 */

const THEME_CSS = path.resolve('src/renderer/src/theme.css');
const COMPONENT_DIR = path.resolve('src/renderer/src');

/** WCAG 2.x AA for normal-size text. The app's smallest type is 12px
 * (`text-xs`) and its body type is 14px (`text-sm`), so **nothing here
 * qualifies for the 3:1 large-text allowance** — 4.5 is the bar for every
 * pair below, deliberately, rather than per-pair judgement about size. */
const AA_NORMAL = 4.5;

/**
 * Which surfaces each text token can actually land on, read off the
 * components rather than assumed:
 *
 *  - `bg` is the window ground (`WindowShell`), `bg-elevated` is the title
 *    bar, the tab bar, the floor pane and **every chat card**
 *    (`kinds.tsx`'s `Card`), and `bg-inset` is `<pre>` blocks and button
 *    hover states.
 *  - `bg-inset` therefore carries **only inherited text** — `text` and
 *    `text-muted`. No call site puts `error`, `warn`, `success` or
 *    `accent` on it, so demanding it would be inventing a requirement.
 *  - The `/10` tints (`bg-bureau-error/10`, `warn/10`, `accent/10`) are
 *    alpha blends over whatever is behind them, which is a card
 *    (`bg-elevated`) or the window ground (`bg`). They are real surfaces
 *    and the blend is computed, not approximated.
 *  - `accent-text` exists only to sit on `accent` — it is the solid
 *    button/badge foreground, and `only ever pairs with bg-bureau-accent`
 *    below asserts that rather than trusting the name.
 */
const CARD_SURFACES = ['bg', 'bg-elevated'] as const;

interface SurfaceSpec {
  /** Solid surfaces this token renders on. */
  readonly on: readonly string[];
  /** Tints (at 10% alpha) this token renders on, and what each sits over. */
  readonly tints?: Readonly<Record<string, readonly string[]>>;
}

const SURFACE_MODEL: Readonly<Record<string, SurfaceSpec>> = {
  // Inherited body text: everywhere, including `<pre>` blocks on inset.
  text: {
    on: ['bg', 'bg-elevated', 'bg-inset'],
    tints: { error: CARD_SURFACES, warn: CARD_SURFACES, accent: CARD_SURFACES },
  },
  // The most-used token in the app (50 call sites) and the one the audit
  // measured failing: inactive tabs, the floor pane, every secondary line
  // in every card, and the collapsed floor strip's inset hover.
  'text-muted': {
    on: ['bg', 'bg-elevated', 'bg-inset'],
    tints: { error: CARD_SURFACES, warn: CARD_SURFACES, accent: CARD_SURFACES },
  },
  // Error notes and the error card, on their own tint; and inside a user
  // message, whose bubble is an `accent/10` tint.
  error: { on: CARD_SURFACES, tints: { error: CARD_SURFACES, accent: CARD_SURFACES } },
  // §14.2's highlighted assumptions and the aborted-message note.
  warn: { on: CARD_SURFACES, tints: { warn: CARD_SURFACES, accent: CARD_SURFACES } },
  // The "recommended" pill — a border and a label, no fill of its own.
  success: { on: CARD_SURFACES },
  // Markdown links, including inside a user bubble's `accent/10` tint.
  accent: { on: CARD_SURFACES, tints: { accent: CARD_SURFACES } },
  // Solid buttons and the tab badge, and nothing else.
  'accent-text': { on: ['accent'] },
};

// ---------------------------------------------------------------------------
// theme.css, parsed rather than restated
// ---------------------------------------------------------------------------

type Palette = Record<string, string>;

function blockAfter(css: string, marker: string): string {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`theme.css no longer contains ${marker}`);
  const open = css.indexOf('{', start);
  const end = css.indexOf('}', open);
  return css.slice(open, end);
}

function tokensIn(block: string): Palette {
  const palette: Palette = {};
  for (const m of block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    palette[m[1]!] = m[2]!.toLowerCase();
  }
  return palette;
}

const css = fs.readFileSync(THEME_CSS, 'utf8');
/** The base `:root` block — the light theme. */
const LIGHT = tokensIn(blockAfter(css, ':root {'));
/** The `prefers-color-scheme: dark` override. */
const DARK_SYSTEM = tokensIn(blockAfter(css, ":root:not([data-theme='light'])"));
/** The explicit `data-theme="dark"` override. */
const DARK_EXPLICIT = tokensIn(blockAfter(css, ":root[data-theme='dark']"));

// ---------------------------------------------------------------------------
// WCAG 2.x relative luminance, sRGB
// ---------------------------------------------------------------------------

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
function linearise(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** Tailwind's `/10` opacity modifier composites the colour over whatever
 * is painted behind it. Both are opaque, so this is a plain source-over. */
function composite(
  fg: [number, number, number],
  bg: [number, number, number],
  alpha: number,
): [number, number, number] {
  return fg.map((c, i) => Math.round(c * alpha + bg[i]! * (1 - alpha))) as [number, number, number];
}

interface Pair {
  readonly fg: string;
  readonly bg: string;
  readonly alpha: number;
  readonly over: string | null;
}

function modelledPairs(): Pair[] {
  const pairs: Pair[] = [];
  for (const [fg, spec] of Object.entries(SURFACE_MODEL)) {
    for (const bg of spec.on) pairs.push({ fg, bg, alpha: 1, over: null });
    for (const [tint, overs] of Object.entries(spec.tints ?? {})) {
      for (const over of overs) pairs.push({ fg, bg: tint, alpha: 0.1, over });
    }
  }
  return pairs;
}

function ratioFor(palette: Palette, pair: Pair): number {
  const fg = palette[pair.fg];
  const bg = palette[pair.bg];
  if (fg === undefined) throw new Error(`theme.css has no --color-${pair.fg}`);
  if (bg === undefined) throw new Error(`theme.css has no --color-${pair.bg}`);
  let surface = channels(bg);
  if (pair.alpha < 1) {
    const behind = palette[pair.over!];
    if (behind === undefined) throw new Error(`theme.css has no --color-${pair.over}`);
    surface = composite(surface, channels(behind), pair.alpha);
  }
  return contrast(channels(fg), surface);
}

function describePair(pair: Pair): string {
  return pair.alpha < 1
    ? `${pair.fg} on ${pair.bg}/10 over ${pair.over}`
    : `${pair.fg} on ${pair.bg}`;
}

// ---------------------------------------------------------------------------
// what the components actually use
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

const ALL_SOURCE = sourceFiles(COMPONENT_DIR)
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');

function usedClassTokens(prefix: string): Set<string> {
  const found = new Set<string>();
  for (const m of ALL_SOURCE.matchAll(new RegExp(`\\b${prefix}-bureau-([a-z-]+)`, 'g'))) {
    found.add(m[1]!);
  }
  return found;
}

describe('§14.7: WCAG AA contrast in both themes (AUDIT #10)', () => {
  /**
   * Standing rule 9, in test form. Everything below is driven by two
   * regex scans and one CSS parse; if any of them silently stopped
   * matching, every assertion would pass over an empty set and this file
   * would be green about nothing. Same guard `rawSqlWritesAreOwned` gives
   * its own scan (AUDIT #4).
   */
  describe('the scans find something at all', () => {
    it('theme.css parsed into three real palettes', () => {
      expect(Object.keys(LIGHT).length).toBeGreaterThanOrEqual(10);
      expect(Object.keys(DARK_SYSTEM).length).toBeGreaterThanOrEqual(10);
      expect(Object.keys(DARK_EXPLICIT).length).toBeGreaterThanOrEqual(10);
    });

    it('the component scan found text and background classes', () => {
      expect(usedClassTokens('text').size).toBeGreaterThan(0);
      expect(usedClassTokens('bg').size).toBeGreaterThan(0);
    });

    it('the model produces a non-trivial number of pairs', () => {
      expect(modelledPairs().length).toBeGreaterThan(20);
    });
  });

  /**
   * The dark palette is written out **twice** in `theme.css` — once under
   * `prefers-color-scheme` and once under an explicit `data-theme`, for
   * the documented reason that an override must win in both directions.
   * Two copies of one decision is standing rule 6's exact shape, and here
   * the drift would be invisible: it only shows up for users whose OS
   * preference and in-app choice disagree.
   */
  it('the two dark blocks are identical — one theme, written twice', () => {
    expect(DARK_EXPLICIT).toEqual(DARK_SYSTEM);
  });

  /**
   * The guard that keeps `SURFACE_MODEL` honest in both directions. It is
   * the hand-written part of this file, so it is the part that can rot.
   */
  describe('the surface model covers exactly the tokens the components use', () => {
    it('every text token a component renders has a modelled surface', () => {
      const unmodelled = [...usedClassTokens('text')].filter(
        (token) => LIGHT[token] !== undefined && SURFACE_MODEL[token] === undefined,
      );
      expect(
        unmodelled,
        'a component renders these text tokens and nothing checks their contrast — ' +
          'add each to SURFACE_MODEL with the surfaces it actually lands on',
      ).toEqual([]);
    });

    it('every modelled token is one a component actually renders', () => {
      const unused = Object.keys(SURFACE_MODEL).filter(
        (token) => !usedClassTokens('text').has(token),
      );
      expect(
        unused,
        'SURFACE_MODEL names text tokens no component uses — a stale entry makes this ' +
          'file look more thorough than it is',
      ).toEqual([]);
    });

    it('every surface the model names is a background a component actually sets', () => {
      const surfaces = new Set(
        modelledPairs().flatMap((p) => (p.over === null ? [p.bg] : [p.bg, p.over])),
      );
      const notARealBackground = [...surfaces].filter((s) => !usedClassTokens('bg').has(s));
      expect(notARealBackground).toEqual([]);
    });

    it('accent-text only ever pairs with bg-bureau-accent, which is why it is modelled that way', () => {
      // Every element that sets `text-bureau-accent-text` must set
      // `bg-bureau-accent` in the same class string. If that stops being
      // true, `accent-text`'s single modelled surface is a guess.
      const offenders: string[] = [];
      for (const m of ALL_SOURCE.matchAll(
        /(?:"|'|`)([^"'`]*text-bureau-accent-text[^"'`]*)(?:"|'|`)/g,
      )) {
        if (!/\bbg-bureau-accent\b/.test(m[1]!)) offenders.push(m[1]!.slice(0, 80));
      }
      expect(offenders).toEqual([]);
    });
  });

  for (const [themeName, palette] of [
    ['light', LIGHT],
    ['dark', DARK_SYSTEM],
  ] as const) {
    describe(`${themeName} theme`, () => {
      for (const pair of modelledPairs()) {
        it(`${describePair(pair)} meets AA`, () => {
          const ratio = ratioFor(palette, pair);
          expect(
            ratio,
            `${describePair(pair)} is ${ratio.toFixed(2)}:1 in the ${themeName} theme, ` +
              `below WCAG AA's ${AA_NORMAL}:1 for normal text (§14.7)`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    });
  }
});
