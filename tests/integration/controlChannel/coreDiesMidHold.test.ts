import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { isProcessAlive, waitUntil } from '../../helpers/packagedApp';
import { checkPolicyFailClosed } from '../../../src/shared/controlChannel/policyCheckClient';
import { newId } from '../../../src/shared/models/ids';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const WORKER_SOURCE = path.resolve('tests/integration/fixtures/controlChannelWorker.ts');

let bundledWorkerPath: string;

beforeAll(async () => {
  const outDir = path.resolve('dist', 'test-bundles');
  mkdirSync(outDir, { recursive: true });
  bundledWorkerPath = path.join(outDir, 'controlChannelWorker.js');
  await esbuild.build({
    entryPoints: [WORKER_SOURCE],
    outfile: bundledWorkerPath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['better-sqlite3'],
  });
}, 30_000);

afterAll(() => {
  rmSync(path.dirname(bundledWorkerPath), { recursive: true, force: true });
});

function rawPost(port: number, urlPath: string, token: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: urlPath,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : null });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * "THE TEST THAT MATTERS MOST" (M4 session 1 prompt): Core dies mid-hold ->
 * the pending call is DENIED, not allowed. CLAUDE.md invariant #6 ("fail
 * closed... unreachable policy check... -> the safe option"), proven for
 * real for the first time — a real child process, hosting a real
 * ControlChannelServer, force-killed by PID (never a graceful shutdown,
 * never a simulated throw) while a real /v1/policy/check request is
 * genuinely held open against it.
 *
 * §11.7's S11 (`hook_failure_denies`) is this same substance under a
 * later name — M6 session 3 formalises that mapping here rather than
 * rebuilding it: an unreachable policy check (the hook's own request
 * timing out because the process answering it is gone) is exactly
 * "hook failure," and "the safe option" for a fail-closed hook is
 * exactly `deny`. Relabelled, not rewritten — the M4 session 1 test body
 * below is unchanged.
 */
describe('Core dies mid-hold -> DENIED, not allowed (real process kill) — S11: hook_failure_denies', () => {
  let tmpDir: string | undefined;
  let child: ChildProcess | undefined;

  afterEach(() => {
    if (child?.pid !== undefined) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore' });
      } catch {
        // Already dead — expected on the happy path, this test kills it itself.
      }
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a policy check held when the Core process is force-killed resolves to deny for the caller', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-controltest-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    const activityLogPath = path.join(tmpDir, 'activity.jsonl');
    const backupsDir = path.join(tmpDir, 'backups');

    child = spawn(process.execPath, [bundledWorkerPath], {
      env: {
        ...process.env,
        BUREAU_CONTROLTEST_DB_PATH: dbPath,
        BUREAU_CONTROLTEST_ACTIVITY_LOG_PATH: activityLogPath,
        BUREAU_CONTROLTEST_MIGRATIONS_DIR: REAL_MIGRATIONS_DIR,
        BUREAU_CONTROLTEST_BACKUPS_DIR: backupsDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childPid = child.pid;
    expect(childPid).toBeDefined();

    let stderrBuf = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
    });

    let port = 0;
    let token = '';
    let pendingCount = 0;
    let sawPendingOne = false;
    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let newlineIndex = buffered.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        const ready = /^READY (\d+) (\S+) (\S+)$/.exec(line);
        if (ready?.[1] && ready[2]) {
          port = Number.parseInt(ready[1], 10);
          token = ready[2];
        }
        const pending = /^PENDING_COUNT (\d+)$/.exec(line);
        if (pending?.[1]) {
          pendingCount = Number.parseInt(pending[1], 10);
          if (pendingCount === 1) sawPendingOne = true;
        }
        newlineIndex = buffered.indexOf('\n');
      }
    });

    const gotReady = await waitUntil(() => port !== 0, 15_000);
    expect(gotReady, `worker never printed READY. stderr: ${stderrBuf}`).toBe(true);

    // Fire the long-poll off in the background — it must never resolve on
    // its own (nothing in this process ever answers it); only the kill
    // below should end it.
    const callId = newId();
    const outcomePromise = checkPolicyFailClosed(() =>
      rawPost(port, '/v1/policy/check', token, {
        callId,
        tool: 'HOLD_ME',
        rawTool: 'HOLD_ME',
        args: {},
        preview: 'a tool call the human has not answered yet',
      }),
    );

    const gotHeld = await waitUntil(() => sawPendingOne, 5_000);
    expect(gotHeld, `worker never reported a held policy check. pendingCount=${pendingCount}, stderr: ${stderrBuf}`).toBe(true);

    // The crux of the test: kill only the Core process, by PID, for real —
    // not a graceful stop(), not a thrown exception standing in for one.
    execFileSync('taskkill', ['/PID', String(childPid), '/F']);

    const died = await waitUntil(() => !isProcessAlive(childPid as number), 10_000);
    expect(died, 'the Core process must actually be dead for this test to mean anything').toBe(true);

    const outcome = await outcomePromise;
    expect(outcome.verdict, `expected deny; got ${JSON.stringify(outcome)}`).toBe('deny');
    expect(outcome.reason).toMatch(/transport failure/);
  }, 30_000);
});
