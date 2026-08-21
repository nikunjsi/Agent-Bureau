import { useState } from 'react';

/**
 * §14.1's floor pane, §14.1's "collapsible to a thin strip." Deliberately
 * an empty-state placeholder only — **no Phaser, no canvas** — per
 * CLAUDE.md: "Do not build the Floor before the Director works." Real
 * rendering is M12's job; this exists so the window layout has the right
 * shape and the collapse/expand interaction is provable now.
 */
export function FloorPane(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
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
    <section
      aria-label="Office floor"
      className="flex w-64 shrink-0 flex-col border-r border-bureau-border bg-bureau-bg-elevated"
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
        <p className="text-xs">It arrives once the Director is working — nothing to see here before then.</p>
      </div>
    </section>
  );
}
