import type { EngineAdapter } from '../../shared/engine/adapter';
import type { ProbeResult } from '../../shared/engine/types';

/**
 * §7.1: `probe()` "MUST NOT throw. MUST finish < 5s."
 *
 * ## The problem, diagnosed rather than assumed
 *
 * `probe()` shells out to the real CLI — a process spawn, a `--version`,
 * an auth check. It flaked once at **5064ms** against that 5s deadline
 * while the test suite was running other things concurrently.
 *
 * The first diagnosis was "N hires means N probes", and that was wrong:
 * `Supervisor` has cached the result per employee lifetime since M6
 * session 2, so it was never per-turn churn. What actually happens is N
 * INDEPENDENT probes — one per employee — each spawning its own process,
 * all under whatever load the machine is already carrying.
 *
 * ## Why caching is the right answer and a longer deadline is not
 *
 * Installed version, binary path and auth status are properties of the
 * **machine**, not of the employee asking. Ten employees spawning ten
 * `claude --version` processes to learn the same fact is the actual
 * defect; the deadline merely exposed it. §7.1's 5s is normative and
 * stays — quietly raising a spec deadline to fit an implementation is how
 * a contract stops meaning anything.
 *
 * ## Single-flight, not just memoised
 *
 * Concurrent callers share ONE in-flight promise. Without that, ten
 * simultaneous hires all miss the empty cache and spawn ten processes
 * anyway — which is precisely the scenario that produced the flake, so a
 * plain memo would have left it in place while looking fixed.
 *
 * The TTL is short: a user who installs or authenticates a CLI while
 * Bureau is running should not have to restart. Stale-but-recent is
 * acceptable because every consumer of a `ProbeResult` already handles the
 * pessimistic case safely (`metered: true`, `installed: false` → the safe
 * direction).
 */

/** Long enough to collapse a burst of hires, short enough that installing
 * a CLI mid-session is noticed without a restart. */
export const PROBE_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readonly at: number;
  readonly result: ProbeResult;
}

export class ProbeCache {
  private readonly settled = new WeakMap<EngineAdapter, CacheEntry>();
  private readonly inFlight = new WeakMap<EngineAdapter, Promise<ProbeResult>>();
  private probeCount = 0;

  constructor(
    private readonly ttlMs: number = PROBE_CACHE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Keyed by the adapter **instance**, not by `adapter.key`.
   *
   * The engine-key version was the obvious choice and it is wrong. The
   * probe answer is system-level for a *given adapter configuration*, but
   * `claudeCodeAdapter.probe()` honours `CLAUDE_CONFIG_DIR` — that is
   * exactly how its own "unauthenticated" test points a probe at a fresh
   * identity — so two `claude-code` adapters configured differently
   * genuinely have different answers. Keying by the string would serve one
   * adapter's result to another, which is the kind of shared-state bug
   * that shows up as an impossible test failure long before anyone
   * suspects the cache.
   *
   * Identity keying still collapses the case that matters: production runs
   * ONE adapter instance per engine with N supervisors on it, so N hires
   * still cost one probe. It simply cannot leak between adapters that were
   * never meant to share.
   *
   * A `WeakMap`, so an adapter that goes away takes its entry with it.
   */
  async probe(adapter: EngineAdapter): Promise<ProbeResult> {
    const cached = this.settled.get(adapter);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.result;

    const existing = this.inFlight.get(adapter);
    if (existing) return existing;

    this.probeCount += 1;
    const pending = adapter
      .probe()
      .then((result: ProbeResult) => {
        this.settled.set(adapter, { at: this.now(), result });
        return result;
      })
      .finally(() => {
        this.inFlight.delete(adapter);
      });

    this.inFlight.set(adapter, pending);
    return pending;
  }

  /** After installing a CLI (§15.4's setup flow, M13) the cached "not
   * installed" is actively wrong — this is how that gets discarded rather
   * than waited out. */
  invalidate(adapter: EngineAdapter): void {
    this.settled.delete(adapter);
  }

  /** How many times the underlying adapter was actually asked. The whole
   * point of this class is that this number stays small under load, so it
   * is exposed for the test that asserts it rather than inferred. */
  get underlyingProbeCount(): number {
    return this.probeCount;
  }
}

/**
 * The default cache, shared across Supervisors so that N employees on one
 * adapter cost one probe — which is the whole point.
 *
 * Safe as a module-level singleton only because entries are keyed by
 * adapter identity (see `probe`): a shared cache keyed by a string would
 * make every Supervisor in the process, including unrelated ones in a test
 * run, contend for the same entry. `Supervisor` still takes an override so
 * a caller that wants isolation can have it outright.
 */
export const globalProbeCache = new ProbeCache();
