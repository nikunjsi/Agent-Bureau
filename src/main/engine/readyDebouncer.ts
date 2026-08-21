/**
 * §7.4 (MUST): "PTY mode detects idle by matching the engine's readyPattern
 * against output, debounced (default 150ms of quiet) so a prompt-like
 * string inside generated text does not falsely match."
 *
 * Pure scheduling logic, deliberately separated from PtyOutputBuffer and
 * from any real process — so the debounce behaviour itself is testable
 * with fake timers, independent of both real process timing and the
 * buffering logic it happens to be paired with in PtySession.
 *
 * The contract: every new chunk resets the quiet timer. Only once
 * `debounceMs` passes with *no* further chunk does it re-check whether the
 * ready condition still holds — deliberately re-checking at fire time
 * (via the `matches` callback), not capturing a snapshot when scheduled,
 * because a chunk arriving in the interim can change the answer.
 */
export class ReadyDebouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly debounceMs: number,
    private readonly onReady: () => void,
  ) {}

  /** Call on every chunk. `matches` is evaluated only if `debounceMs` passes with no further call. */
  notifyChunk(matches: () => boolean): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (matches()) this.onReady();
    }, this.debounceMs);
  }

  /** Cancels any pending check without firing it — for session teardown. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
