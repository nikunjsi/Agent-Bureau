import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';
import { seedLongChat } from './fixtures/chatSeed';

/**
 * P-4 / chaos scenario #12, the chat half, in the real packaged app: a
 * conversation of 10,000 messages. Asserted: the newest message appears, and
 * the window still answers a click once it has. Timings are printed, not
 * asserted (a wall-clock bound on a real process is the flake class D-3
 * removes); the numbers are recorded in the pre-M11 plan's P-4 row.
 */
test('chat with 10,000 messages loads, shows the newest, and stays responsive', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-chat10k-'));
  const seeded = await seedLongChat(userDataDir, 10_000);
  const launched = Date.now();
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });
  try {
    const win = await app.firstWindow();
    await win.getByRole('heading', { name: /^Bureau/ }).waitFor({ timeout: 120_000 });
    const shell = Date.now();
    const conversation = win.getByRole('list', { name: 'Conversation' });
    await expect(
      conversation.getByText(seeded.newestBody.split(' The ')[0]!, { exact: false }),
    ).toBeVisible({ timeout: 120_000 });
    const newestVisible = Date.now();

    const rendered = await win.evaluate(
      () => document.querySelectorAll('[aria-label="Conversation"] > li').length,
    );

    // P-4: the conversation is paged. The newest page is on screen and the
    // earlier ones are one keyboard-reachable button away.
    const earlier = conversation.getByRole('button', { name: 'Show earlier messages' });
    await expect(earlier).toBeVisible();
    await expect(conversation.getByText('Message 9799.', { exact: false })).toHaveCount(0);
    const olderStarted = Date.now();
    await earlier.click();
    await expect(conversation.getByText('Message 9799.', { exact: false })).toBeVisible({
      timeout: 60_000,
    });
    const olderShown = Date.now();

    // Responsiveness: a click on another tab is handled promptly after load.
    const clickStarted = Date.now();
    await win.getByRole('tab', { name: /Checkpoints/ }).click({ timeout: 60_000 });
    await expect(win.getByRole('tab', { name: /Checkpoints/ })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 60_000 },
    );
    const clickHandled = Date.now();

    console.log(
      `[P-4] 10,000 messages: shell ${shell - launched} ms after launch; newest visible ${newestVisible - shell} ms after shell; an earlier page shown ${olderShown - olderStarted} ms after the click; a tab click handled in ${clickHandled - clickStarted} ms; ${rendered} rows in the DOM on load`,
    );
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
