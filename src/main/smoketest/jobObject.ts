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
  ensureJobObject();

  const dummyScriptPath = resolveDummyScriptPath();

  const dummy = spawn(process.execPath, [dummyScriptPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
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

  containProcess(dummyPid);

  writeResult({ bureauPid: process.pid, dummyPid });
  // Intentionally do not call app.exit() — this process must stay alive
  // until the test harness force-kills it.
}

function resolveDummyScriptPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'bureau-dummy.js');
  }
  return path.join(app.getAppPath(), 'dist', 'resources', 'bin', 'bureau-dummy.js');
}
