import { describe, expect, it } from 'vitest';
import { PtyOutputBuffer } from '../../../src/main/engine/ptyOutputBuffer';

describe('PtyOutputBuffer (§7.4 / M3 step 3)', () => {
  it('reassembles a ready pattern split across two feed() calls (the chunk-boundary trap)', () => {
    // "chunk boundaries land mid-sequence constantly" — an ANSI colour
    // escape sequence split exactly down the middle between two chunks,
    // immediately followed by the prompt text a ready pattern looks for.
    // \x1b[32m is "set foreground green"; splitting mid-sequence is the
    // realistic failure mode, not splitting between two whole sequences.
    const buffer = new PtyOutputBuffer({ readyPattern: /> $/ });

    buffer.feed('some output\x1b[3'); // escape sequence cut in half
    expect(buffer.matchesReadyPattern()).toBe(false); // correctly not ready yet — nothing to see here

    buffer.feed('2m> '); // second half of the sequence, plus the prompt text itself
    expect(buffer.bufferedText).toBe('some output\x1b[32m> ');
    expect(buffer.matchesReadyPattern()).toBe(true); // reassembled correctly, pattern now matches
  });

  it('does not corrupt or drop text across many small feeds', () => {
    const buffer = new PtyOutputBuffer();
    const parts = ['a', 'b', 'c', '\x1b[', '1', ';', '2', 'm', 'd', 'e'];
    for (const part of parts) buffer.feed(part);
    expect(buffer.bufferedText).toBe('abc\x1b[1;2mde');
  });

  it('a ready pattern anchored at the end stops matching once more output arrives after it', () => {
    // This is the actual mechanism the debounce depends on: §7.4 needs a
    // prompt-like string *inside generated text* to stop matching once
    // more text follows it, which requires the pattern to be checked
    // against the live, growing buffer — not a one-time snapshot.
    const buffer = new PtyOutputBuffer({ readyPattern: /> $/ });
    buffer.feed('working... > ');
    expect(buffer.matchesReadyPattern()).toBe(true);

    buffer.feed('actually more text follows');
    expect(buffer.matchesReadyPattern()).toBe(false);
  });

  it('respects the rolling buffer cap without breaking matching against recent output', () => {
    const buffer = new PtyOutputBuffer({ readyPattern: /> $/, rollingBufferCap: 16 });
    buffer.feed('x'.repeat(100));
    buffer.feed('> ');
    expect(buffer.bufferedText.length).toBeLessThanOrEqual(16);
    expect(buffer.matchesReadyPattern()).toBe(true);
  });

  it('a global-flagged pattern does not misbehave via mutable lastIndex across calls', () => {
    // A naive `new RegExp(pattern)` reuse with a 'g' flag would carry
    // lastIndex state between .test() calls, making matches depend on call
    // history rather than current content — this pins that it does not.
    const globalPattern = /> $/g;
    const buffer = new PtyOutputBuffer({ readyPattern: globalPattern });
    buffer.feed('one > ');
    expect(buffer.matchesReadyPattern()).toBe(true);
    expect(buffer.matchesReadyPattern()).toBe(true); // would flip to false on the 2nd call if lastIndex leaked
  });

  it('no readyPattern configured means matchesReadyPattern is always false, never throws', () => {
    const buffer = new PtyOutputBuffer();
    buffer.feed('anything > ');
    expect(buffer.matchesReadyPattern()).toBe(false);
  });
});
