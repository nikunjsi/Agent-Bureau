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
  private readonly settled = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ProbeResult>>();
  private probeCount = 0;

  constructor(
    private readonly ttlMs: number = PROBE_CACHE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Keyed by the adapter's engine key, because that is the granularity the
   * answer actually varies at — two employees on `claude-code` learn the
   * same thing.
   */
  async probe(adapter: EngineAdapter): Promise<ProbeResult> {
    const key = adapter.key;

    const cached = this.settled.get(key);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.result;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    this.probeCount += 1;
    const pending = adapter
      .probe()
      .then((result: ProbeResult) => {
        this.settled.set(key, { at: this.now(), result });
        return result;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, pending);
    return pending;
  }

  /** After installing a CLI (§15.4's setup flow, M13) the cached "not
   * installed" is actively wrong — this is how that gets discarded rather
   * than waited out. */
  invalidate(engineKey?: string): void {
    if (engineKey === undefined) {
      this.settled.clear();
      return;
    }
    this.settled.delete(engineKey);
  }

  /** How many times the underlying adapter was actually asked. The whole
   * point of this class is that this number stays small under load, so it
   * is exposed for the test that asserts it rather than inferred. */
  get underlyingProbeCount(): number {
    return this.probeCount;
  }
}

/**
 * The process-wide cache. A module-level singleton because the fact it
 * caches is process-wide — one machine, one set of installed CLIs — and
 * threading an instance through every Supervisor construction would make
 * the shared-ness a per-call-site decision that could quietly be got
 * wrong. `Supervisor` takes an optional override so tests can use their
 * own without leaking state between them.
 */
export const globalProbeCache = new ProbeCache();
