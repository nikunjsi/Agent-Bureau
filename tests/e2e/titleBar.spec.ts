import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';
import { seedChat } from './fixtures/chatSeed';

/**
 * AUDIT M0–M2 #7 — invariant #10: *every visual state maps to a real
 * system state.*
 *
 * Both of the title bar's indicators lied, in different ways:
 *
 *  - The bell was the literal `🔔 0`, in the visible text **and** the
 *    `aria-label`, while the real pending-checkpoint count sat one
 *    selector away in the same store. A user with a blocking checkpoint
 *    waiting was told nothing was.
 *  - The `⏱` meter rendered `…` whenever the total was `null`, which the
 *    Core uses for *"nothing reported a cost"* — and `costs.summary`
 *    returned SQL NULL for an empty `usage` table too, so **a fresh
 *    install showed a loading ellipsis that never resolved**.
 *
 * Why this is an e2e and not a component test: `spendMeter.test.ts` proves
 * the sentences, and would go on passing if `TitleBar` never called the
 * function or the handler never sent the field. What was broken here was
 * the *wiring* — a component rendering a constant instead of the store —
 * and a test that hands a component its props reproduces the bug rather
 * than catching it (standing rule 1). So: the real packaged app, its own
 * database, its own `costs.summary`, its own `stateDelta` push.
 */
async function launch(userDataDir: string): Promise<{
  app: Awaited<ReturnType<typeof electron.launch>>;
  win: Page;
}> {
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.getByRole('heading', { name: /^Bureau/ }).waitFor();
  return { app, win };
}

/** The meter and the bell are found by their accessible names, which is
 * also the assertion §14.7 cares about: a screen-reader user gets the same
 * fact a sighted one does, not a bare digit next to an emoji. */
const meter = (win: Page) => win.getByTitle(/today|cost has not|working out/i);
const bell = (win: Page) => win.getByTitle(/waiting for you|Nothing is waiting/i);

test('a fresh install shows a real $0.00, not a loading ellipsis forever', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-titlebar-fresh-'));
  // Deliberately unseeded: no company, no employees, and above all an
  // empty `usage` table — the state every user is in on first launch, and
  // the one the old code could never leave.
  const { app, win } = await launch(userDataDir);

  try {
    await expect(meter(win)).toContainText('$0.00 today');
    await expect(meter(win)).not.toContainText('…');

    // §14.1's unmetered disclosure stays silent when there is nothing to
    // disclose — an empty roster has no unmetered employee in it.
    await expect(meter(win)).not.toContainText('not reported');

    // And the bell tells the truth about zero, which it also did before —
    // by accident. The seeded case below is what distinguishes the two.
    await expect(bell(win)).toHaveAttribute('title', /Nothing is waiting for you/i);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('the bell counts real pending checkpoints, in the label and the accessible name', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-titlebar-seeded-'));
  // `seedChat` writes exactly one real pending checkpoint through the
  // production `insertCheckpoint`. The old hardcoded `🔔 0` renders a
  // literal zero against it — this is the assertion the mutation fails.
  await seedChat(userDataDir);
  const { app, win } = await launch(userDataDir);

  try {
    await expect(bell(win)).toContainText('1');
    await expect(bell(win)).toHaveAttribute('title', /1 decision is waiting for you/i);

    // The count agrees with §9.4's other surface in the same window — the
    // Checkpoints tab badge — because both read the one `checkpoints`
    // slice. Two surfaces disagreeing about how many decisions are waiting
    // is precisely what §9.4's "all reflecting one piece of state" forbids.
    await expect(win.getByRole('tab', { name: /Checkpoints/ })).toContainText('1');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
