import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';
import { seedTwoProjectChats } from './fixtures/chatSeed';

/**
 * M11 S2-1c, §K.2: the conversation switcher in the **real packaged app** —
 * rows written by the production writers, listed by the real
 * `chat.listConversations`, rendered by the real renderer. The user sees the
 * company conversation and both projects, each with its stage and marker,
 * and switching shows one conversation's messages and not the other's.
 */
test('the switcher lists every conversation and switches between two projects', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-switcher-'));
  await seedTwoProjectChats(userDataDir);
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const switcher = win.getByRole('navigation', { name: 'Conversations' });
    await switcher.waitFor();
    const entries = switcher.getByRole('button');
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toContainText('Company');
    await expect(switcher.getByRole('button', { name: /Luigi Trattoria/ })).toContainText(
      'Understanding the request',
    );
    const pizzeriaEntry = switcher.getByRole('button', { name: /Luigi Pizzeria/ });
    await expect(pizzeriaEntry).toContainText('Waiting on you');

    // The newest thing said is the trattoria's, so that conversation opens.
    const conversation = win.getByRole('list', { name: 'Conversation' });
    await expect(conversation.getByText('TRATTORIA: how many tables do you have?')).toBeVisible();
    await expect(conversation.getByText(/PIZZERIA:/)).toHaveCount(0);
    await expect(switcher.getByRole('button', { name: /Luigi Trattoria/ })).toHaveAttribute(
      'aria-current',
      'true',
    );

    // Switch: the pizzeria's messages, and none of the trattoria's.
    await pizzeriaEntry.click();
    await expect(
      conversation.getByText('PIZZERIA: the brief is ready for you to approve.'),
    ).toBeVisible();
    await expect(conversation.getByText(/TRATTORIA:/)).toHaveCount(0);
    await expect(pizzeriaEntry).toHaveAttribute('aria-current', 'true');

    // And back.
    await switcher.getByRole('button', { name: /Luigi Trattoria/ }).click();
    await expect(conversation.getByText('TRATTORIA: how many tables do you have?')).toBeVisible();
    await expect(conversation.getByText(/PIZZERIA:/)).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
