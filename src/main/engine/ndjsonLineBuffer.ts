/**
 * §7.6 trap #1 (M3 session 2): `--output-format stream-json` is documented
 * as newline-delimited JSON, but the docs stop short of a verbatim
 * guarantee that a single event's JSON never gets split across two stdout
 * reads — and pipe chunks split mid-line constantly in practice. A
 * `JSON.parse` on a partial line throws, and the failure mode is
 * intermittent and load-dependent, which is a miserable thing to diagnose
 * from a bug report. This buffers raw text to complete newlines before
 * ever calling `JSON.parse`, the same "accumulate before trusting a
 * boundary" discipline session 1 used for PTY escape sequences
 * (PtyOutputBuffer) — a different failure mode, the same underlying
 * lesson: a chunk boundary is a transport artifact, never a semantic one.
 */
export interface NdjsonFeedResult {
  /** Every complete line that parsed as valid JSON, in order. */
  readonly parsed: unknown[];
  /** Every complete line that was NOT valid JSON, verbatim — surfaced, never thrown, so one bad line doesn't take down the whole stream. */
  readonly malformedLines: string[];
}

export class NdjsonLineBuffer {
  private pending = '';

  /**
   * Feeds one raw text chunk. A line is only ever parsed once a `\n` has
   * actually been seen after it — an incomplete trailing line is held back
   * and prefixed onto the next chunk, however many `feed()` calls that
   * takes.
   */
  feed(chunk: string): NdjsonFeedResult {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    // The last element is whatever came after the final '\n' in the
    // accumulated text so far — complete only if the chunk itself ended
    // exactly on a newline (in which case it's ''); held back otherwise.
    this.pending = lines.pop() ?? '';

    const parsed: unknown[] = [];
    const malformedLines: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) continue; // blank lines between events are not an error
      try {
        parsed.push(JSON.parse(line));
      } catch {
        malformedLines.push(line);
      }
    }
    return { parsed, malformedLines };
  }

  /** Whatever's left un-terminated when the stream ends — should be empty for a well-formed stream; a non-empty result means the process exited mid-line. */
  get pendingTail(): string {
    return this.pending;
  }
}
