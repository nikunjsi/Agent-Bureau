import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadyDebouncer } from '../../../src/main/engine/readyDebouncer';

describe('ReadyDebouncer (§7.4 MUST: 150ms of quiet, default)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT fire on a match immediately followed by more output within the debounce window', () => {
    // This is the exact false-positive §7.4 exists to prevent: a
    // prompt-like string inside generated text, with more text
    // immediately following it.
    const onReady = vi.fn();
    const debouncer = new ReadyDebouncer(150, onReady);

    debouncer.notifyChunk(() => true); // "matches" at this instant
    vi.advanceTimersByTime(100); // still within the 150ms window
    debouncer.notifyChunk(() => false); // more output arrived — no longer matches, and resets the timer
    vi.advanceTimersByTime(150); // now let it go quiet

    expect(onReady).not.toHaveBeenCalled();
  });

  it('DOES fire after a genuine quiet period following a match', () => {
    const onReady = vi.fn();
    const debouncer = new ReadyDebouncer(150, onReady);

    debouncer.notifyChunk(() => true);
    vi.advanceTimersByTime(150); // real silence, no further chunk

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('re-checks the match condition at fire time, not at schedule time', () => {
    // Scheduled while matching, but the condition has changed by the time
    // the timer actually fires (matches() is called lazily, not captured).
    const onReady = vi.fn();
    const debouncer = new ReadyDebouncer(150, onReady);
    let currentlyMatches = true;

    debouncer.notifyChunk(() => currentlyMatches);
    currentlyMatches = false; // e.g. some other logic invalidated it before quiet was reached
    vi.advanceTimersByTime(150);

    expect(onReady).not.toHaveBeenCalled();
  });

  it('each new chunk resets the timer — only the LAST chunk\'s quiet period counts', () => {
    const onReady = vi.fn();
    const debouncer = new ReadyDebouncer(150, onReady);

    for (let i = 0; i < 5; i++) {
      debouncer.notifyChunk(() => true);
      vi.advanceTimersByTime(100); // never lets a single window complete
    }
    expect(onReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150); // now actually go quiet
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels a pending check without firing it', () => {
    const onReady = vi.fn();
    const debouncer = new ReadyDebouncer(150, onReady);

    debouncer.notifyChunk(() => true);
    debouncer.dispose();
    vi.advanceTimersByTime(150);

    expect(onReady).not.toHaveBeenCalled();
  });
});
