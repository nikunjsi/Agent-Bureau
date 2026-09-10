import { useEffect, useState } from 'react';
import { useBureauStore } from '../store/bureauStore';
import { microsToUsd } from '../../../shared/models/money';

export function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }): React.JSX.Element {
  const companyName = useBureauStore((state) => state.company?.name ?? null);
  const setActiveTab = useBureauStore((state) => state.setActiveTab);
  const [todayUsdMicros, setTodayUsdMicros] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.bureau.costs.summary({ projectId: null }).then((result) => {
      if (cancelled) return;
      if (result.ok) setTodayUsdMicros(result.data.item.todayUsdMicros);
    }, console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-bureau-border bg-bureau-bg-elevated px-3 text-sm text-bureau-text">
      <div className="flex items-center gap-2">
        <span aria-hidden="true">☰</span>
        <h1 className="text-sm font-medium">Bureau{companyName ? ` — ${companyName}` : ''}</h1>
      </div>
      <div className="flex items-center gap-4">
        <span aria-label="Spend today">
          ⏱ {todayUsdMicros === null ? '…' : `$${microsToUsd(todayUsdMicros).toFixed(2)}`} today
        </span>
        <span aria-label="0 notifications">🔔 0</span>
        {/*
          The door to §14.9's memory view (M10). It lives here rather than in
          the tab bar because Memory is an on-demand tab, not a fifth
          permanent one — §14.5's own pattern for the company-wide Activity
          timeline, which is likewise "shown only when opened".

          It is a real, reachable control rather than a seam: a view nothing
          can open is not a view, and standing rule 2's lesson generalises
          past guards. The floor's wall clock (§13.6) is the *other* opener
          §14.5 describes, and that one waits for M12 to draw a clock.
        */}
        <button
          type="button"
          onClick={() => setActiveTab('memory')}
          aria-label="Open what Bureau remembers"
          className="rounded px-1 hover:bg-bureau-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        >
          🧠
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Open settings"
          className="rounded px-1 hover:bg-bureau-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
