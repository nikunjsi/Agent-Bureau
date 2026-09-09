import { test, expect, _electron as electron } from '@playwright/test';
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';
import { seedChat } from './fixtures/chatSeed';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const WORKER_SOURCE = path.resolve('tests/e2e/fixtures/chatStreamKillWorker.ts');

/**
 * §28's M9 gate, second line: **"Killing the app mid-stream leaves a
 * clearly marked aborted message."**
 *
 * The failure mode this exists to prevent is not an ugly message. It is a
 * **truncated message that looks complete** — a half-sentence the user
 * reads as the Director's actual answer and acts on. So the assertions are
 * in two halves: the partial text survives, AND it is unmistakably marked
 * as interrupted.
 *
 * ## What is real here, stated precisely
 *
 * A real OS process is killed with SIGKILL while genuinely mid-stream,
 * holding an unflushed tail, having written its row through the production
 * `ChatStream`. The real packaged app then boots on that same database, its
 * own real `reconcile()` marks the row `aborted`, and the real renderer
 * shows what it shows.
 *
 * The killed process is **not the app's own main process**, and that is
 * named rather than glossed: nothing inside the app produces a streamed
 * reply until the Director exists (M11), so there is no honest way to have
 * the app itself be mid-stream today, and inventing a test-only IPC method
 * to start one would put a path in the shipped product that exists for a
 * test. What the app is on the hook for here — recovering the row and
 * telling the user — is fully real. The kill-point suite
 * (`tests/integration/killPoints.test.ts`, point 17) covers the same
 * mechanism from the other side, with the process that dies being the one
 * that owns the database.
 */
test('a stream killed mid-sentence comes back clearly marked, not silently truncated', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-chat-abort-'));
  const outDir = path.resolve('dist', 'test-bundles');
  mkdirSync(outDir, { recursive: true });
  const workerPath = path.join(outDir, 'chatStreamKillWorker.js');

  try {
    const { conversationId } = await seedChat(userDataDir);

    // Bundled inside the project tree, not the OS temp dir: `require`
    // resolves `better-sqlite3` by walking up from the bundle's own
    // location, and os.tmpdir() is typically a different drive entirely
    // (the same reason killPoints.test.ts bundles here).
    await esbuild.build({
      entryPoints: [WORKER_SOURCE],
      outfile: workerPath,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      external: ['better-sqlite3'],
    });

    const child = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        BUREAU_CHATKILL_USER_DATA_DIR: userDataDir,
        BUREAU_CHATKILL_CONVERSATION_ID: conversationId,
        BUREAU_CHATKILL_MIGRATIONS_DIR: REAL_MIGRATIONS_DIR,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    await new Promise<void>((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(
        () => reject(new Error(`the stream worker never announced itself. stderr:\n${stderr}`)),
        20_000,
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        if (buffered.includes('STREAMING ')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the stream worker exited early (${code}). stderr:\n${stderr}`));
      });
    });

    // The kill. No grace, no cleanup, no chance to finalise the row — the
    // same thing a power cut does.
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    const app = await electron.launch({
      executablePath: resolvePackagedExePath(),
      args: [`--user-data-dir=${userDataDir}`],
      env: packagedAppEnv(),
    });

    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await win.getByRole('heading', { name: /^Bureau/ }).waitFor();

      const conversation = win.getByRole('list', { name: 'Conversation' });
      // The words that were persisted before the kill are kept: an aborted
      // reply showing what it managed to say is more useful than an empty
      // one. The tail that was still inside the throttle window is gone —
      // which is precisely what makes what remains look like a finished
      // sentence, and precisely why the marker below is the real assertion.
      await expect(
        conversation.getByText(/You could keep the recipes as plain files/),
      ).toBeVisible();
      await expect(conversation.getByText(/nothing to pay for/)).toHaveCount(0);

      // And it is marked. This is the assertion the gate is actually
      // about — without it the line above is a half-sentence presented as
      // a finished answer.
      await expect(
        conversation.getByText('This reply was interrupted and is incomplete.'),
      ).toBeVisible();

      // Not marked as still arriving, either: a message frozen on "typing…"
      // is the other way this could mislead.
      await expect(conversation.getByText('typing…')).toHaveCount(0);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(workerPath, { force: true });
  }
});
