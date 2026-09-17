import { app } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureJobObject, containProcess } from '../process/jobObject';
import { writeResult } from './result';

/**
 * Gate 4: Job Object containment (§4.4). Run only when
 * `BUREAU_SMOKETEST=jobobject`. Spawns a dummy long-lived child, contains it
 * in Bureau's Job Object, and writes both PIDs out — then deliberately
 * stays alive. The outer test (tests/integration/job-object.test.ts) hard-
 * kills *this* process by PID (never `taskkill /T`, which would kill the
 * child itself and prove nothing) and asserts the dummy dies too, which can
 * only happen via JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
 */
export async function runJobObjectSmoketest(): Promise<void> {
  // P-10: `BUREAU_SMOKETEST_GRANDCHILD=1` makes the dummy spawn a grandchild
  // after it is contained. `BUREAU_SMOKETEST_NO_CONTAIN=1` skips containment
  // entirely: the negative control, run by hand, never by the suite.
  const withGrandchild = process.env['BUREAU_SMOKETEST_GRANDCHILD'] === '1';
  const contain = process.env['BUREAU_SMOKETEST_NO_CONTAIN'] !== '1';
  if (contain) ensureJobObject();

  const dummyScriptPath = resolveDummyScriptPath();

  const dummy = spawn(process.execPath, [dummyScriptPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BUREAU_DUMMY_GRANDCHILD: withGrandchild ? 'on-go' : '',
    },
    stdio: [withGrandchild ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    // P-10: in grandchild mode the dummy is DETACHED. libuv puts every
    // non-detached child in its own kill-on-close job, so a non-detached
    // child dies with its parent whether or not Bureau's Job Object exists,
    // and a test built on one proves nothing (measured: it passes with
    // containment switched off). A detached child escapes libuv's job, so
    // only Bureau's containment can kill it.
    detached: withGrandchild,
  });

  const dummyPid = await new Promise<number>((resolve, reject) => {
    dummy.once('error', reject);
    dummy.once('spawn', () => {
      if (dummy.pid === undefined) {
        reject(new Error('dummy child spawned with no pid'));
      } else {
        resolve(dummy.pid);
      }
    });
  });

  if (contain) containProcess(dummyPid);

  if (!withGrandchild) {
    writeResult({ bureauPid: process.pid, dummyPid });
    return;
  }

  const grandchildPid = await new Promise<number>((resolve, reject) => {
    let buffered = '';
    dummy.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const match = /BUREAU_GRANDCHILD_PID=(\d+)/.exec(buffered);
      if (match?.[1] !== undefined) resolve(Number(match[1]));
    });
    dummy.once('exit', () => reject(new Error('dummy exited before spawning a grandchild')));
    dummy.stdin?.write('go\n');
  });
  writeResult({ bureauPid: process.pid, dummyPid, grandchildPid });
  // Intentionally do not call app.exit() — this process must stay alive
  // until the test harness force-kills it.
}

function resolveDummyScriptPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'bureau-dummy.js');
  }
  return path.join(app.getAppPath(), 'dist', 'resources', 'bin', 'bureau-dummy.js');
}
