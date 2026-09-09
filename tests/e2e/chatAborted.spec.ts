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
 *
 * The second test in this file covers §14.7's other half for the one state
 * no fixture can seed — a reply that is streaming *right now*.
 */

/**
 * Bundles the stream worker inside the project tree, not the OS temp dir:
 * `require` resolves `better-sqlite3` by walking up from the bundle's own
 * location, and os.tmpdir() is typically a different drive entirely (the
 * same reason killPoints.test.ts bundles here).
 *
 * Shared by both tests in this file. Playwright runs a file's tests
 * serially and the config pins `workers: 1`, so the shared path cannot be
 * raced — the hazard PROJECT-CHECKLIST's 2026-09-09 row describes is two
 * *suites* at once, which is a rule about how the suites are run.
 */
async function bundleWorker(): Promise<string> {
  const outDir = path.resolve('dist', 'test-bundles');
  mkdirSync(outDir, { recursive: true });
  const workerPath = path.join(outDir, 'chatStreamKillWorker.js');
  await esbuild.build({
    entryPoints: [WORKER_SOURCE],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['better-sqlite3'],
  });
  return workerPath;
}

function spawnStreamWorker(
  userDataDir: string,
  conversationId: string,
  workerPath: string,
): ReturnType<typeof spawn> {
  return spawn(process.execPath, [workerPath], {
    env: {
      ...process.env,
      BUREAU_CHATKILL_USER_DATA_DIR: userDataDir,
      BUREAU_CHATKILL_CONVERSATION_ID: conversationId,
      BUREAU_CHATKILL_MIGRATIONS_DIR: REAL_MIGRATIONS_DIR,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Resolves once the worker's row is genuinely mid-stream — over a real OS
 * pipe, rather than after a guessed sleep — and returns that row's id.
 *
 * The id matters: the seed writes its own interrupted message (so
 * `chatCompose.spec.ts` can check §14.7 against a non-`complete` state),
 * so "the message that says it was interrupted" is no longer unique on the
 * page. Asserting against **this** row is what makes the assertion about
 * the kill rather than about whatever else is on screen.
 */
async function waitForStreaming(child: ReturnType<typeof spawn>): Promise<string> {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise<string>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(
      () => reject(new Error(`the stream worker never announced itself. stderr:\n${stderr}`)),
      20_000,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = /STREAMING (\S+)/.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the stream worker exited early (${code}). stderr:\n${stderr}`));
    });
  });
}

test('a stream killed mid-sentence comes back clearly marked, not silently truncated', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-chat-abort-'));

  let workerPath = '';
  try {
    const { conversationId } = await seedChat(userDataDir);
    workerPath = await bundleWorker();
    const child = spawnStreamWorker(userDataDir, conversationId, workerPath);
    const killedMessageId = await waitForStreaming(child);

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

      // Scoped to the row the killed process actually wrote. The seed
      // also contains an interrupted message (for §14.7's colour check in
      // chatCompose.spec.ts), so an unscoped locator would match either —
      // and a test that passes on the wrong row is not testing the kill.
      const conversation = win.locator(`li[data-message-id="${killedMessageId}"]`);
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
      await expect(conversation).toHaveAttribute('data-message-status', 'aborted');
    } finally {
      await app.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
    if (workerPath !== '') rmSync(workerPath, { force: true });
  }
});

/**
 * §14.7's "status never conveyed by colour alone", for the one state
 * `chatCompose.spec.ts` cannot produce.
 *
 * A `streaming` row cannot be seeded and then booted on: §5.1 requires
 * `reconcile()` to mark any row still `streaming` from before the app
 * started as `aborted`, and it correctly does. So the row here is made
 * **while the app is already running** — the same real separate process
 * the test above kills, this time left alive — and the window is reloaded
 * so the real `chat.listMessages` serves it. Reload is not restart:
 * `reconcile()` runs once per app launch, so the row is still genuinely
 * mid-stream when the renderer reads it.
 *
 * Nothing test-only is added to the shipped app to achieve this. That was
 * session 1's explicit rule (docs/NEXT-VERSION.md §K.1) and it still holds:
 * the app produces no stream of its own until the Director exists (M11).
 */
test('a live streaming reply says so in words, with all colour removed', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-live-stream-'));
  let workerPath = '';
  let child: ReturnType<typeof spawn> | null = null;

  try {
    const { conversationId } = await seedChat(userDataDir);
    workerPath = await bundleWorker();

    const app = await electron.launch({
      executablePath: resolvePackagedExePath(),
      args: [`--user-data-dir=${userDataDir}`],
      env: packagedAppEnv(),
    });

    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await win.getByRole('heading', { name: /^Bureau/ }).waitFor();

      // The app has booted and reconciled. NOW start a stream, so the row
      // is mid-flight rather than a leftover.
      child = spawnStreamWorker(userDataDir, conversationId, workerPath);
      await waitForStreaming(child);

      // A reload re-hydrates the window and re-fetches the conversation
      // through the real handler. It does not re-run `reconcile()`.
      await win.reload();
      await win.getByRole('list', { name: 'Conversation' }).waitFor();

      await win.addStyleTag({
        content: `* { color: #000 !important; background: #fff !important;
                      border-color: #000 !important; fill: #000 !important; }`,
      });

      const row = win.locator('li[data-message-status="streaming"]');
      await expect(row).toHaveCount(1);
      // The word, not the pulsing dot: the dot is `aria-hidden` decoration
      // and is invisible to a screen reader, a monochrome screen and
      // `prefers-reduced-motion` alike.
      await expect(row).toContainText('typing…');
      // And it is not claiming to be finished or interrupted.
      await expect(row).not.toContainText(/interrupted/i);
    } finally {
      await app.close();
    }
  } finally {
    // **Wait for it to actually die before deleting its database.**
    // `kill` only sends the signal; the worker still holds the SQLite file
    // open when it returns, and `rmSync` on Windows then fails with EPERM —
    // after every assertion has passed, which makes it look like a product
    // failure and is not one. The test above already waits on `exit` for
    // the same reason; this one did not, and flaked accordingly.
    if (child !== null) {
      const exited = new Promise<void>((resolve) => child!.on('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(userDataDir, { recursive: true, force: true });
    if (workerPath !== '') rmSync(workerPath, { force: true });
  }
});
