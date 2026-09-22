import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import {
  PROBE_LIVENESS_CEILING_MS,
  PROBE_RESPONSIVENESS_BUDGET_MS,
} from '../../../src/shared/engine/types';

/**
 * §7.8 test 1: "probe() returns within its budget and never throws,
 * including when the binary is absent." M3 session 2's prompt asks all
 * three failure cases to be tested explicitly, not just the happy path.
 *
 * **2026-09-10 — the numbers moved, and which assertions are safe changed
 * with them.** §7.8 now has two bounds instead of one overloaded 5s
 * constant. Just as importantly, this file used to carry *two* wall-clock
 * assertions against a hard deadline and only one of them was sound: an
 * injected never-resolving promise makes `elapsed` a property of a
 * `setTimeout` and nothing else, while a real `claude.exe` launch makes it a
 * property of the machine's page cache. The first is a test. The second was
 * a five-time flake waiting to happen, and it did happen — five occurrences,
 * four wrong diagnoses (`PROJECT-CHECKLIST.md`). Timing is asserted here
 * only where no real process is involved.
 */
/**
 * A hosted GitHub Actions runner has the CLI (ci.yml installs the tested
 * pin) but can never be signed in: there is no subscription on it and no
 * credential is given to it. GitHub sets `GITHUB_ACTIONS=true` on every
 * runner; it is unset on a dev box. Only the one test that needs a real
 * sign-in keys off it — every other test here runs in CI against the real
 * binary, including the logged-out one.
 */
const ON_HOSTED_CI_RUNNER = process.env.GITHUB_ACTIONS === 'true';
if (ON_HOSTED_CI_RUNNER) {
  console.log(
    '[claudeCodeAdapterProbe.test.ts] skipping the real-auth test: a hosted CI runner has no signed-in Claude Code CLI',
  );
}

describe('ClaudeCodeAdapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS }) — three failure cases (§7.8 test 1)', () => {
  it('binary absent: never throws, returns installed:false — determined, not merely unknown', async () => {
    const adapter = new ClaudeCodeAdapter({
      resolveBinary: async () => ({ resolvedPathString: '', binaryPath: null }),
    });
    const start = Date.now();
    const result = await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });
    const elapsedMs = Date.now() - start;

    expect(result.installed).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.metered).toBe(true); // §24.5 safe direction
    // The distinction the `indeterminate` state exists to protect, asserted
    // from the other side: the resolver genuinely looked and it genuinely is
    // not there. This is a real observation and must keep saying so, or the
    // new state would have bought honesty about slowness at the cost of
    // honesty about absence.
    expect(result.determination).toBe('determined');
    // Safe to assert: no process is launched on this path at all — the
    // resolver is injected and returns null. Nothing here can be slow
    // because of a cold page cache.
    expect(elapsedMs).toBeLessThan(PROBE_RESPONSIVENESS_BUDGET_MS);
  });

  it(
    'binary present but hanging: never throws, fires at the liveness ceiling, and a caller cannot raise the ceiling',
    async () => {
      // A real OS process that hangs on exactly `--version` (the adapter's
      // fixed argv — not configurable per test) turned out to have no
      // reliable, portable answer on Windows (tried several standalone
      // executables; each either resolved instantly or wasn't found) — an
      // *injected never-resolving promise* proves the exact thing this test
      // is actually about (withTimeout()'s deadline firing) more directly
      // than fighting real process semantics would have. It is also why this
      // is the ONE test in this file that may assert elapsed time: there is
      // no process, so the elapsed time is the timer and nothing else.
      const neverResolves = new Promise<string>(() => {});
      const adapter = new ClaudeCodeAdapter({
        resolveBinary: async () => ({ resolvedPathString: '', binaryPath: 'C:\\fake\\claude.exe' }),
        runVersionCheck: () => neverResolves,
      });
      const start = Date.now();
      // Deliberately asks for FOUR TIMES the ceiling. §7.8 makes "never
      // hangs" the adapter's own guarantee rather than the caller's choice,
      // so this call must come back at the ceiling regardless — which makes
      // one test prove both that the guard fires and that it cannot be
      // widened from a call site.
      const result = await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS * 4 });
      const elapsedMs = Date.now() - start;

      expect(result.installed).toBe(false);
      expect(result.determination).toBe('indeterminate');
      expect(result.error).toContain(String(PROBE_LIVENESS_CEILING_MS));
      expect(result.metered).toBe(true);
      // The real proof this test exists for: it did NOT hang forever waiting
      // on a promise that never resolves — it fired right at the ceiling, not
      // early, not indefinitely late, and not at the 120s the caller asked
      // for. The 200ms upper margin is Promise/event-loop settling overhead,
      // not slack in the deadline itself.
      expect(elapsedMs).toBeGreaterThanOrEqual(PROBE_LIVENESS_CEILING_MS);
      expect(elapsedMs).toBeLessThan(PROBE_LIVENESS_CEILING_MS + 200);
    },
    PROBE_LIVENESS_CEILING_MS + 10_000,
  );

  describe('binary present but unauthenticated', () => {
    let tempConfigDir: string;
    let originalConfigDir: string | undefined;

    afterEach(() => {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      if (tempConfigDir) rmSync(tempConfigDir, { recursive: true, force: true });
    });

    it(
      'never throws, returns installed:true, authenticated:false — verified against a real fresh CLAUDE_CONFIG_DIR, not simulated',
      async () => {
        // §7.6's empirical check A (M3 session 2) proved CLAUDE_CONFIG_DIR
        // genuinely isolates auth state (a fresh dir starts logged out; the
        // real ~/.claude.json is untouched) — this test relies on exactly
        // that proof, applied here rather than re-derived.
        tempConfigDir = mkdtempSync(path.join(tmpdir(), 'bureau-probe-unauth-'));
        originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = tempConfigDir;

        const adapter = new ClaudeCodeAdapter();
        const result = await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });

        // **The wall-clock assertion that used to be here is gone, and its
        // removal is half of this session's fix.** It read
        // `expect(elapsedMs).toBeLessThan(5000)` against a REAL launch of a
        // 318.7 MB `claude.exe`, twice, sequentially — identical exposure to
        // the assertion in `claudeCodeAdapterBuildLaunchSpec.test.ts` that
        // failed five times, and unflaked here only by luck. It also asserted
        // nothing this test is named for. What this test is for is the
        // *answer*: a real, installed, logged-out CLI reports installed with
        // authentication genuinely absent. That is what it now checks.
        expect(result.installed).toBe(true); // the real binary was found and --version worked
        expect(result.authenticated).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.metered).toBe(true); // safe direction — no confirmed subscription
        // Load-bearing given the above: without this, a probe that timed out
        // would satisfy `authenticated: false` and `metered: true` for
        // completely the wrong reason and this test would pass while testing
        // nothing. The removed timing assertion is replaced by an assertion
        // that the answer was actually reached, which is the honest version of
        // what the timing assertion was reaching for.
        expect(result.determination).toBe('determined');
      },
      PROBE_LIVENESS_CEILING_MS + 10_000,
    );
  });

  it.skipIf(ON_HOSTED_CI_RUNNER)(
    'the real machine, with real auth, reports authenticated:true and metered:false (this dev box has a Pro subscription; skipped on a hosted CI runner, which cannot be signed in)',
    async () => {
      const adapter = new ClaudeCodeAdapter();
      const result = await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });
      expect(result.determination).toBe('determined');
      expect(result.installed).toBe(true);
      expect(result.authenticated).toBe(true);
      expect(result.metered).toBe(false);
      expect(result.binaryPath).toBeTruthy();
      expect(result.version).toBeTruthy();
      // No elapsed-time assertion, for the reason given on the logged-out
      // test above: this launches the real CLI twice and the machine's page
      // cache is not this test's subject.
    },
    PROBE_LIVENESS_CEILING_MS + 10_000,
  );
});

/**
 * §7.8's third state, which is the whole point of this session.
 *
 * Every test here injects `runVersionCheck`, so the elapsed times are
 * `setTimeout`s and not process launches — deliberately, because a test
 * about "what happens when the CLI is slow" must not itself depend on
 * whether the CLI happens to be slow.
 */
describe('ClaudeCodeAdapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS }) — indeterminate is not "not installed" (§7.8)', () => {
  /** Resolves after `ms`, standing in for a cold `claude --version`. */
  function slowVersionCheck(ms: number): () => Promise<string> {
    return () => new Promise<string>((resolve) => setTimeout(() => resolve('1.2.3'), ms));
  }

  const PRESENT_BINARY = { resolvedPathString: '', binaryPath: 'C:/fake/claude.exe' };

  it('a probe that exceeds the responsiveness budget reports indeterminate — it does NOT report the CLI as absent', async () => {
    // The shipped bug, reproduced: the binary IS there (the resolver says
    // so), it is simply slower than the caller's budget. Measured cold, the
    // whole probe runs 3875-4372ms and a single Defender-scanned launch has
    // reached 9846ms, so 4s against a 2.5s budget is squarely the real case
    // and not a contrived one.
    const adapter = new ClaudeCodeAdapter({
      resolveBinary: async () => PRESENT_BINARY,
      runVersionCheck: slowVersionCheck(4_000),
    });

    const result = await adapter.probe({ budgetMs: PROBE_RESPONSIVENESS_BUDGET_MS });

    expect(result.determination).toBe('indeterminate');
    // Fail closed in behaviour — invariant #6 and §24.5 are unchanged, and
    // this half must keep holding or the fix traded safety for honesty.
    expect(result.installed).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.metered).toBe(true);
    // Honest in message — the half that is new. The error must describe a
    // check that did not finish, never a machine state nothing observed.
    expect(result.error).toContain('Could not determine');
    expect(result.error).toContain(String(PROBE_RESPONSIVENESS_BUDGET_MS));
    expect(result.error?.toLowerCase()).not.toContain('was not found');
  });

  it(
    'the SAME probe, given the liveness ceiling instead, returns a real answer — the budget is the only difference',
    async () => {
      // The pair that proves the state is about the budget and not about the
      // machine. Same adapter configuration, same launch; only the caller's
      // patience changes, and with it the answer's honesty about itself. This
      // is `Supervisor.assign()`'s case (nobody waiting) against
      // `canEnableZeroCostMode`'s (a person holding a toggle).
      //
      // 6s, deliberately: it must sit ABOVE the old 5000ms deadline, because
      // this test doubles as the reproduction of the shipped bug. A single
      // Defender-scanned launch of the real 318.7 MB binary has been measured
      // at 9846ms, so 6s is inside the real cold distribution rather than a
      // contrivance — and dropping the ceiling back to 5000 turns this exact
      // scenario back into `installed: false`, which is what shipped.
      const adapter = new ClaudeCodeAdapter({
        resolveBinary: async () => PRESENT_BINARY,
        runVersionCheck: slowVersionCheck(6_000),
        // `claude auth status` is a real execFile on a fake path, so it
        // rejects fast; that is a genuine "not authenticated", which is fine
        // here — this test is about `installed` and `determination`.
      });

      const result = await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });

      expect(result.determination).toBe('determined');
      expect(result.installed).toBe(true);
      expect(result.version).toBe('1.2.3');
    },
    PROBE_LIVENESS_CEILING_MS + 10_000,
  );

  it(
    'omitting the budget means the ceiling, not the responsiveness budget — a caller that did not think about it waits for a right answer',
    async () => {
      // The default matters more than it looks: `probe()` with no arguments is
      // what `buildLaunchSpec`'s own test and every future caller will write.
      // A 4s launch discriminates the two constants precisely — it is beyond
      // 2.5s and far inside 30s — so this fails loudly if the default is ever
      // quietly changed to the responsive one.
      const adapter = new ClaudeCodeAdapter({
        resolveBinary: async () => PRESENT_BINARY,
        runVersionCheck: slowVersionCheck(4_000),
      });

      const result = await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });

      expect(result.determination).toBe('determined');
      expect(result.installed).toBe(true);
    },
    PROBE_LIVENESS_CEILING_MS + 10_000,
  );

  it('two sequential launches cannot consume more than the outer budget between them (the `-500` that was not a reserve)', async () => {
    // The old code passed `PROBE_TIMEOUT_MS - 500` to EACH of two sequential
    // launches under a 5000ms outer deadline, so 9000ms of inner budget sat
    // inside a 5000ms bound and only `withTimeout` was actually holding it.
    // This asserts the property that replaced it: whatever the first launch
    // spends, the second is offered only what is genuinely left.
    const offered: number[] = [];
    const adapter = new ClaudeCodeAdapter({
      resolveBinary: async () => PRESENT_BINARY,
      runVersionCheck: (_binaryPath, _env, timeoutMs) => {
        offered.push(timeoutMs);
        return new Promise<string>((resolve) => setTimeout(() => resolve('1.2.3'), 1_000));
      },
    });

    const budgetMs = 4_000;
    await adapter.probe({ budgetMs });

    expect(offered).toHaveLength(1);
    // Never more than the caller's whole budget — the specific thing
    // `budget - 500` per launch could not promise.
    expect(offered[0]).toBeLessThanOrEqual(budgetMs);
    // And it is derived from the clock rather than a constant: the resolver
    // above is awaited first, so at least some budget is already gone.
    expect(offered[0]).toBeGreaterThan(0);
  }, 15_000);
});
