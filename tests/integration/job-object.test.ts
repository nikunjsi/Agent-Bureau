import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolvePackagedExePath,
  waitForFile,
  isProcessAlive,
  waitUntil,
} from '../helpers/packagedApp';

/**
 * §28 M0 gate 4: killing Bureau while a child process is running must leave
 * no surviving child — the Job Object containment in §4.4. Verified
 * behaviourally: spawn the real packaged app in job-object smoketest mode
 * (src/main/smoketest/jobObject.ts), let it spawn+contain a dummy child,
 * then force-kill *only the Bureau process* by PID.
 *
 * Deliberately does NOT use `taskkill /T` (which recursively kills the
 * process tree itself) — that would make this test pass even with no Job
 * Object code at all. The dummy's death here can only be explained by
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE firing when Windows closes the job
 * handle on the Bureau process's exit.
 */
describe('Job Object containment: no orphaned child after a hard kill', () => {
  let child: ChildProcess | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    // Best-effort cleanup in case an assertion failed before we killed it.
    if (child?.pid !== undefined) {
      try {
        // stdio: 'ignore' — on the happy path the process is already gone
        // (killed via the Job Object during the test itself), so taskkill's
        // "process not found" is expected noise, not a real error.
        execFileSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore' });
      } catch {
        // Already dead — expected on the happy path.
      }
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('kills the dummy child when Bureau is force-killed by PID only', async () => {
    const exe = resolvePackagedExePath();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-jobtest-'));
    const outFile = path.join(tmpDir, 'result.json');

    child = spawn(exe, [], {
      env: { ...process.env, BUREAU_SMOKETEST: 'jobobject', BUREAU_SMOKETEST_OUT: outFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const raw = await waitForFile(outFile, 20_000);
    const { bureauPid, dummyPid } = JSON.parse(raw) as { bureauPid: number; dummyPid: number };

    expect(isProcessAlive(dummyPid)).toBe(true);

    // The crux of the test: kill only the Bureau process, never the tree.
    execFileSync('taskkill', ['/PID', String(bureauPid), '/F']);

    const dummyDied = await waitUntil(() => !isProcessAlive(dummyPid), 10_000);

    expect(dummyDied).toBe(true);
    expect(isProcessAlive(dummyPid)).toBe(false);
  });
});
