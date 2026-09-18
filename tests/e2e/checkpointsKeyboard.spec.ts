import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';
import { seedReviewQueue, readCheckpoint } from './fixtures/checkpointCardSeed';

/**
 * X-16 / §14.4: the Checkpoints view, **driven by keyboard only**.
 *
 * "Pending checkpoints, `blocking` first. Same card as in chat.
 * Keyboard-driven — `J`/`K` to move, `1`–`9` to choose an option, `Enter` to
 * confirm — because in practice these get processed in batches. Answered
 * checkpoints remain visible for the session with the decision shown."
 *
 * The view rendered a title and a context line in `created_at` order, with no
 * card, no ordering, no keyboard and no history. The rules are unit-tested in
 * `tests/unit/renderer/checkpointsKeyboard.test.ts`; this is the part those
 * cannot show — that the keys are actually wired to the real handler, in the
 * real packaged app, and that the answer lands in the database.
 *
 * Only the tab is reached by mouse. Everything after it is typed.
 */
test('answers two checkpoints, blocking first, without touching the mouse', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-cp-keys-'));
  const queue = await seedReviewQueue(userDataDir);

  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.getByRole('list', { name: 'Conversation' }).waitFor();
    await win.getByRole('tab', { name: /Checkpoints/ }).click();

    const list = win.getByRole('list', { name: 'Pending checkpoints' });
    await expect(list).toBeVisible();

    // §14.4's order, asserted against a queue where `created_at` disagrees
    // with it: the `soon` one was raised first.
    const cards = list.getByRole('region');
    await expect(cards.first()).toHaveAttribute('aria-label', `Decision: ${queue.blockingTitle}`);
    await expect(cards.nth(1)).toHaveAttribute('aria-label', `Decision: ${queue.soonTitle}`);

    // The cursor starts on the first. `1` marks, and nothing is answered
    // until Enter — the mark is shown so a user can see what they picked.
    await list.focus();
    await win.keyboard.press('1');
    await expect(
      win.getByText('Press Enter to confirm: Skip the bad rows and carry on'),
    ).toBeVisible();
    await win.keyboard.press('Enter');

    // Answered, so the Core drops it from the pending slice and the view
    // follows. The second is now the only one left.
    await expect(cards).toHaveCount(1, { timeout: 10_000 });
    await expect(cards.first()).toHaveAttribute('aria-label', `Decision: ${queue.soonTitle}`);

    // "Answered checkpoints remain visible for the session with the
    // decision shown."
    const history = win.getByRole('region', { name: 'Answered this session' });
    await expect(history.getByText(queue.blockingTitle)).toBeVisible();
    await expect(history.getByText(/Skip the bad rows and carry on/)).toBeVisible();

    // The second, with the cursor having stayed where it was: `2` then Enter.
    await list.focus();
    await win.keyboard.press('2');
    await win.keyboard.press('Enter');
    await expect(cards).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await app.close();
  }

  const blocking = readCheckpoint(userDataDir, queue.blockingId);
  expect(blocking?.status).toBe('answered');
  expect(blocking?.answer?.optionId).toBe('skip');
  expect(blocking?.answered_by).toBe('user');

  const soon = readCheckpoint(userDataDir, queue.soonId);
  expect(soon?.status).toBe('answered');
  expect(soon?.answer?.optionId).toBe('green');
  rmSync(userDataDir, { recursive: true, force: true });
});
