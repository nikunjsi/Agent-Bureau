export interface PtyOutputBufferOptions {
  readyPattern?: RegExp;
  /** Cap on the rolling buffer's length, in characters. Default 8192 — comfortably larger than any realistic prompt/escape-sequence run, small enough to never matter for memory. */
  rollingBufferCap?: number;
}

/**
 * §7.4 / M3 step 3: the piece of PtySession responsible for surviving a
 * chunk boundary landing mid-escape-sequence (or mid-anything else a
 * pattern needs to match). Deliberately pure — no timers, no node-pty, no
 * process — so the exact-chunk-boundary edge cases are testable
 * deterministically, without depending on how an OS or a real child
 * process happens to fragment its writes on a given run.
 *
 * node-pty on Windows always delivers already-UTF8-decoded strings via
 * `onData` — confirmed by reading `windowsPtyAgent.js`, which unconditionally
 * calls `outSocket.setEncoding('utf8')` regardless of any `encoding` option
 * passed to `pty.spawn` (that option is silently ignored on Windows). Node's
 * own `StringDecoder`, wired in by `setEncoding`, already reassembles a
 * multi-byte character split across two underlying reads correctly — so
 * this class does not re-implement that. What it exists for is different:
 * an ANSI escape sequence (or a ready pattern's own match target) is made
 * of individually-valid, already-decoded characters, so byte-level decoding
 * can't be what splits it — a *chunk* boundary can still land in the middle
 * of it, because chunk boundaries are a transport artifact with no
 * relationship to escape-sequence or pattern boundaries. Matching against
 * the rolling accumulated buffer, never a single chunk in isolation, is the
 * actual fix.
 */
export class PtyOutputBuffer {
  private rolling = '';
  private readonly cap: number;
  private readonly readyPattern: RegExp | null;

  constructor(options: PtyOutputBufferOptions = {}) {
    this.cap = options.rollingBufferCap ?? 8192;
    // Strip a 'g' flag defensively — a global regex carries mutable
    // lastIndex state across .test() calls, which would make matching
    // depend on call history rather than current buffer content.
    this.readyPattern = options.readyPattern
      ? new RegExp(options.readyPattern.source, options.readyPattern.flags.replace('g', ''))
      : null;
  }

  /** Accumulates one decoded string chunk into the rolling buffer. */
  feed(chunk: string): void {
    this.rolling = (this.rolling + chunk).slice(-this.cap);
  }

  /** True if the rolling buffer's *current, full* accumulated text matches the ready pattern. */
  matchesReadyPattern(): boolean {
    return this.readyPattern !== null && this.readyPattern.test(this.rolling);
  }

  /** The accumulated text — exposed for tests and for feeding a resync/raw view; not meant as a general read API. */
  get bufferedText(): string {
    return this.rolling;
  }
}
