import { useEffect, useState } from 'react';
import { useBureauStore } from '../store/bureauStore';
import { microsToUsd } from '../../../shared/models/money';

export function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }): React.JSX.Element {
  const companyName = useBureauStore((state) => state.company?.name ?? null);
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
        <span aria-label="Spend today">⏱ {todayUsdMicros === null ? '…' : `$${microsToUsd(todayUsdMicros).toFixed(2)}`} today</span>
        <span aria-label="0 notifications">🔔 0</span>
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
