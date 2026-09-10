import { useCallback, useEffect, useRef, useState } from 'react';
import { useBureauStore } from '../store/bureauStore';

/**
 * §14.1's floor pane, §14.1's "collapsible to a thin strip." Deliberately
 * an empty-state placeholder only — **no Phaser, no canvas** — per
 * CLAUDE.md: "Do not build the Floor before the Director works." Real
 * rendering is M12's job; this exists so the window layout has the right
 * shape and the collapse/expand interaction is provable now.
 *
 * AUDIT M0–M2 #17 added the other two things §14.1 asks of this pane and
 * §28's M2 item 5 listed as build items: the **draggable, persisted**
 * splitter, and the auto-collapse below the minimum window width.
 */

/** §14.1's minimum window width. The pane gets out of the way below it. */
const MIN_WINDOW_WIDTH = 1280;

/** Matches `general.floorPaneWidth`'s own bounds in §16.1. Clamped on read
 * as well as on write: a hand-edited settings row, or a width dragged on a
 * much wider monitor, must not be able to leave a pane covering the chat
 * on this one. */
const MIN_PANE = 160;
const MAX_PANE = 720;
const clampPane = (width: number): number => Math.min(MAX_PANE, Math.max(MIN_PANE, width));

export function FloorPane(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);

  /**
   * The persisted width (§16.1 `general.floorPaneWidth`), read from the
   * `settings` slice the Core pushes rather than fetched separately —
   * invariant #11: the renderer holds no authoritative state, and the
   * width is a real setting like any other.
   *
   * `undefined` until the slice arrives, which is why the pane renders at
   * the default rather than at zero while hydrating.
   */
  const persistedWidth = useBureauStore((state) => {
    const value = state.settings?.['general.floorPaneWidth'];
    return typeof value === 'number' ? clampPane(value) : undefined;
  });

  /** Live width during a drag. `null` means "no drag in flight, use what
   * the Core says" — so the pane follows the settings slice the moment the
   * Core confirms the write, and never fights it. */
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? persistedWidth ?? 256;

  /**
   * §14.1: "Minimum window 1280×800; below that the floor auto-collapses."
   *
   * Observes the window rather than the pane, because the rule is about
   * the window and observing the pane would be circular — collapsing
   * changes the pane's own width, which would re-trigger the observer.
   *
   * `autoCollapsed` is tracked separately from the user's own collapse so
   * that widening the window restores the pane for someone who never
   * collapsed it, without un-collapsing it for someone who did.
   */
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  useEffect(() => {
    // `outerWidth`, not `innerWidth`, and this was a real bug caught by
    // the e2e rather than by reading: §14.1's 1280 is a **window** size,
    // and the renderer's `innerWidth` is the *content* width, which on
    // this machine is 1264 for a window sized exactly 1280 (measured; the
    // frame takes 16px). Comparing content width against a window
    // threshold auto-collapsed the floor on every launch at the minimum
    // size — the feature firing constantly instead of never.
    const check = (): void => setAutoCollapsed(window.outerWidth < MIN_WINDOW_WIDTH);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = true;
      startX.current = event.clientX;
      startWidth.current = width;
      // Pointer capture rather than window-level listeners: the pointer
      // keeps reporting to this element even when it leaves it, which is
      // most of a drag, and the browser releases it for us if the gesture
      // is cancelled.
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    setDragWidth(clampPane(startWidth.current + (event.clientX - startX.current)));
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const settled = clampPane(startWidth.current + (event.clientX - startX.current));
    // Written once, at the end of the gesture. Persisting every pointer
    // move would be a database write per frame and an activity event per
    // frame with it (invariant #3), for a value nobody needs a history of.
    void window.bureau.settings
      .set({ key: 'general.floorPaneWidth', value: settled })
      .then((result) => {
        // The Core is the authority. On success the pushed `settings`
        // slice carries the same number and `persistedWidth` takes over;
        // on failure, dropping the local width snaps the pane back to
        // what is actually stored rather than showing a width that was
        // never saved (invariant #11).
        setDragWidth(null);
        if (!result.ok) console.error('[floor] could not save the splitter width', result.error);
      }, console.error);
  }, []);

  /** Keyboard operation, because a control only a mouse can reach fails
   * §14.7's "full keyboard navigation". The arrow steps are what a
   * `separator` widget is expected to respond to. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 48 : 16;
      let next: number | null = null;
      if (event.key === 'ArrowLeft') next = clampPane(width - step);
      if (event.key === 'ArrowRight') next = clampPane(width + step);
      if (next === null) return;
      event.preventDefault();
      setDragWidth(next);
      void window.bureau.settings
        .set({ key: 'general.floorPaneWidth', value: next })
        .then(() => setDragWidth(null), console.error);
    },
    [width],
  );

  if (collapsed || autoCollapsed) {
    return (
      <button
        type="button"
        onClick={() => {
          setCollapsed(false);
          // Expanding by hand in a too-narrow window is a deliberate
          // choice, and §14.1's auto-collapse is a default rather than a
          // lock. It re-collapses on the next resize below the minimum.
          setAutoCollapsed(false);
        }}
        aria-label="Expand the floor view"
        className="flex w-6 shrink-0 items-center justify-center border-r border-bureau-border bg-bureau-bg-elevated text-bureau-text-muted hover:bg-bureau-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
      >
        <span aria-hidden="true" className="[writing-mode:vertical-rl]">
          Floor
        </span>
      </button>
    );
  }

  return (
    <>
      <section
        aria-label="Office floor"
        style={{ width: `${String(width)}px` }}
        className="flex shrink-0 flex-col border-r border-bureau-border bg-bureau-bg-elevated"
      >
        <div className="flex items-center justify-between border-b border-bureau-border px-2 py-1 text-xs text-bureau-text-muted">
          <span>Floor</span>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse the floor view"
            className="rounded px-1 hover:bg-bureau-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            «
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-bureau-text-muted">
          <p>The office floor isn&apos;t built yet.</p>
          <p className="text-xs">
            It arrives once the Director is working — nothing to see here before then.
          </p>
        </div>
      </section>
      {/*
        A real `separator` with `aria-valuenow`, so a screen-reader user is
        told what it does and where it currently sits — the same reasoning
        as the title bar's indicators (§14.7). Kept outside the `<section>`
        so the pane's own width is exactly the persisted number and the
        handle does not eat into it.
      */}
      <div
        role="separator"
        aria-label="Resize the floor view"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={MIN_PANE}
        aria-valuemax={MAX_PANE}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        className="w-1 shrink-0 cursor-col-resize bg-bureau-border hover:bg-bureau-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
      />
    </>
  );
}
