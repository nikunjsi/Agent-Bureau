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
import { spawn } from 'node:child_process';

process.stdout.write(`BUREAU_DUMMY_PID=${process.pid}\n`);

// P-10: with BUREAU_DUMMY_GRANDCHILD=on-go, wait for "go" on stdin (sent once
// this process is in the Job Object), then spawn a grandchild of the same kind
// and report its pid. Waiting makes the test about job INHERITANCE, not about
// a race between spawning and containment.
if (process.env['BUREAU_DUMMY_GRANDCHILD'] === 'on-go') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    if (!chunk.includes('go')) return;
    const grandchild = spawn(process.execPath, [__filename], {
      env: { ...process.env, BUREAU_DUMMY_GRANDCHILD: '', ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
      // Detached for the same reason the dummy is (see smoketest/jobObject.ts):
      // only job INHERITANCE from the contained dummy may kill it.
      detached: true,
    });
    grandchild.once('spawn', () => {
      process.stdout.write(`BUREAU_GRANDCHILD_PID=${grandchild.pid ?? ''}\n`);
    });
  });
}

setInterval(() => {
  // Kept alive deliberately; the test harness kills it (indirectly, via the
  // Job Object) rather than it ever exiting on its own.
}, 60_000);
