import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';
import {
  seedBlockingCheckpoint,
  readCheckpoint,
  countCheckpointCards,
} from './fixtures/checkpointCardSeed';

/**
 * X-11 / §9.4 surface 1: **the card the Core wrote, answered from the UI.**
 *
 * §9.4 calls the Director chat the primary surface for a pending checkpoint,
 * and `MessageRow.tsx` has rendered a `checkpoint` message since M9 — but
 * until X-11 nothing in the Core ever wrote one. The only such row in the tree
 * was in `chatSeed.ts`, so every existing proof of the card started by seeding
 * the card.
 *
 * **Nothing is seeded into the chat here.** The fixture raises a real
 * `blocking` checkpoint and the packaged app's own surfacing tick writes the
 * message; the test answers by clicking the rendered option; the row, read
 * back through the real schema after the app closes, carries the answer.
 *
 * **The gate's other half.** §28's M8 gate is about a `permission` checkpoint
 * holding an agent. A permission row cannot be driven from here: `reconcile()`
 * cancels pending ones at startup by design, because the hold they release
 * lived in the previous process's memory (§9.1). That half is
 * `tests/integration/checkpoints/permissionHold.test.ts` — a real control
 * channel, a real hold, and the same `checkpoints.answerPermission` handler
 * this card's Allow/Deny buttons call. Neither test is the gate alone.
 */
test('the Core writes the chat card for a blocking checkpoint, and answering it there is real', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-cp-card-'));
  const { checkpointId, title } = await seedBlockingCheckpoint(userDataDir);

  // The card this spec finds can only be the app's: there is none to find
  // yet. Without this line the test would still pass if the fixture grew a
  // seeded card later, and would then be proving the renderer again.
  expect(countCheckpointCards(userDataDir)).toBe(0);

  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.getByRole('list', { name: 'Conversation' }).waitFor();

    // The card appears because the app's checkpoints tick surfaced it. The
    // first pass is one tick interval after launch (15 s), so this waits
    // longer than the rest of the suite deliberately.
    const card = win.getByRole('region', { name: `Decision: ${title}` });
    await expect(card).toBeVisible({ timeout: 30_000 });

    await card.getByRole('button', { name: /Stop and wait for me/ }).click();

    // The card goes because the answer made the checkpoint non-pending and a
    // pushed patch said so — the live-state path, for a card no fixture wrote.
    await expect(card).toBeHidden({ timeout: 10_000 });
  } finally {
    await app.close();
  }

  expect(countCheckpointCards(userDataDir)).toBe(1);
  const answered = readCheckpoint(userDataDir, checkpointId);
  expect(answered?.status).toBe('answered');
  expect(answered?.answer?.optionId).toBe('stop');
  expect(answered?.answered_by).toBe('user');
  rmSync(userDataDir, { recursive: true, force: true });
});
