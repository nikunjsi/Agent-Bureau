/**
 * A trivial, long-lived child process used only by
 * tests/integration/job-object.test.ts (§28 M0 gate 4). It exists purely to
 * be contained by Bureau's Windows Job Object and prove that killing Bureau
 * leaves no orphan behind.
 *
 * Run via `process.execPath` with `ELECTRON_RUN_AS_NODE=1` — the same
 * mechanism later milestones use for bureau-hook/bureau-tools (§18.1), so
 * this establishes that pattern rather than inventing a one-off.
 */
process.stdout.write(`BUREAU_DUMMY_PID=${process.pid}\n`);

setInterval(() => {
  // Kept alive deliberately; the test harness kills it (indirectly, via the
  // Job Object) rather than it ever exiting on its own.
}, 60_000);
