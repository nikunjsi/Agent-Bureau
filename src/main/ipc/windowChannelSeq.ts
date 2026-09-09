/**
 * Per-window, per-channel sequence numbers for pushed events.
 *
 * ## Why this is not one shared counter
 *
 * It was one, module-level, in `stateDelta.ts` since M2, with a doc comment
 * asserting that sharing it across windows "is safe" because a `full` delta
 * resets each renderer's own tracking. That reasoning does not survive a
 * second window plus a live producer:
 *
 * ```
 *   Window A loads   -> full, seq=1   A.lastApplied = 1
 *   Window B loads   -> full, seq=2   B.lastApplied = 2
 *   a patch is sent  -> seq=3
 *     B expects 3 -> applies
 *     A expects 2 -> DROPS it (bureauStore.applyDelta), and then waits for
 *                    a `full` delta, which only ever arrives on
 *                    `did-finish-load`.
 * ```
 *
 * Window A is then silently stale until someone reloads it. Nothing had
 * ever hit this because `pushPatch` had no callers; M9's live checkpoint
 * patches and chat pushes are what make it reachable, so it is fixed
 * before it has a caller rather than after.
 *
 * A window earns its counters when it finishes loading. `hasChannels()`
 * being false is therefore the same statement as "this window has not been
 * sent a full snapshot yet", which is why a broadcast skips it: it will get
 * a `full` on `did-finish-load` regardless, and a patch it cannot place is
 * worse than no patch.
 */

/** Named channels are separate sequences. They are applied to different
 * stores in the renderer, so interleaving them on one counter would make
 * every chat push look like a `stateDelta` gap and vice versa. */
export type PushChannel = 'stateDelta' | 'chatMessage';

/** Keyed by the window object itself, so a closed window's counters are
 * collected with it — nothing has to remember to clean up. */
const counters = new WeakMap<object, Map<PushChannel, number>>();

/** Called when a window finishes loading. Every channel restarts at 0, so
 * the first `stateDelta` after a load is seq 1 — matching a renderer whose
 * own state was just re-created by that same load. */
export function startWindowChannels(win: object): void {
  counters.set(win, new Map());
}

export function hasChannels(win: object): boolean {
  return counters.has(win);
}

export function nextSeqFor(win: object, channel: PushChannel): number {
  const forWindow = counters.get(win);
  if (forWindow === undefined) {
    throw new Error(
      'nextSeqFor() called for a window that has not finished loading — callers must check hasChannels() and skip, not invent a sequence',
    );
  }
  const next = (forWindow.get(channel) ?? 0) + 1;
  forWindow.set(channel, next);
  return next;
}
