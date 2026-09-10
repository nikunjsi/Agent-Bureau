import { useEffect, useState } from 'react';
import { useBureauStore } from '../store/bureauStore';
import { describeCheckpointBell, describeSpendMeter } from './format';

export function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }): React.JSX.Element {
  const companyName = useBureauStore((state) => state.company?.name ?? null);
  const setActiveTab = useBureauStore((state) => state.setActiveTab);

  /**
   * AUDIT M0–M2 #7 — invariant #10, "every visual state on the floor maps
   * to a real system state".
   *
   * `undefined` is deliberately the initial value rather than `null`: the
   * Core uses `null` to mean *"nothing reported a cost"* (§11.5.1,
   * AUDIT #18), which is a real answer, and a renderer that starts at
   * `null` has already claimed it before asking. The two are different
   * system states and `describeSpendMeter` renders them differently.
   */
  const [summary, setSummary] = useState<
    { todayUsdMicros: number | null; unmeteredEmployeeCount: number } | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    window.bureau.costs.summary({ projectId: null }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setSummary({
          todayUsdMicros: result.data.item.todayUsdMicros,
          unmeteredEmployeeCount: result.data.item.unmeteredEmployeeCount,
        });
      }
    }, console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * §9.4's surface 3. The same `checkpoints` slice `RightPanel`'s badge and
   * the chat card read, so the three cannot disagree about how many are
   * waiting — which is the whole content of §9.4's "all reflecting one
   * piece of state".
   *
   * It was `🔔 0`, hardcoded, in the visible text **and** the accessible
   * name, one selector away from the truth. A literal in place of a state
   * is the cleanest possible violation of invariant #10, and it read as
   * "nothing is waiting for you" to a user with a blocking checkpoint
   * sitting in the Checkpoints tab.
   */
  const pendingCheckpoints = useBureauStore((state) => state.checkpoints.length);

  const meter = describeSpendMeter(summary?.todayUsdMicros, summary?.unmeteredEmployeeCount ?? 0);
  const bell = describeCheckpointBell(pendingCheckpoints);

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-bureau-border bg-bureau-bg-elevated px-3 text-sm text-bureau-text">
      <div className="flex items-center gap-2">
        <span aria-hidden="true">☰</span>
        <h1 className="text-sm font-medium">Bureau{companyName ? ` — ${companyName}` : ''}</h1>
      </div>
      <div className="flex items-center gap-4">
        <span aria-label={meter.description} title={meter.description}>
          <span aria-hidden="true">⏱ </span>
          {meter.label}
        </span>
        {/*
          §14.7: "status never conveyed by colour alone (icon + label
          always)." The count is the label, the bell is the icon, and the
          accessible name is a whole sentence rather than a bare number —
          `🔔 2` tells a screen-reader user nothing about what the 2 is.
        */}
        <span aria-label={bell.description} title={bell.description}>
          <span aria-hidden="true">🔔 </span>
          {bell.label}
        </span>
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
