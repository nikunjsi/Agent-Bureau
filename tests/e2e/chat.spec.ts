import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';
import { seedChat } from './fixtures/chatSeed';

/**
 * §14.2's eight `kind` renderings, against the **real packaged app**.
 *
 * Why this lives here and not in vitest: a component test that renders a
 * hand-built message array proves the component and not the path
 * (standing rule 1 — the exact class the M3–M6 audit was about). Every
 * message below is written by the production `appendChatMessage` into a
 * real database, read back through the real `chat.listMessages` handler,
 * over the real preload, into the real store, and rendered by the real
 * app. Nothing in the renderer is stubbed and no fixture is handed to a
 * component directly.
 */
async function openChat(userDataDir: string): Promise<{
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
  // Chat is the default tab (§14.1) — no click needed, and asserting that
  // is part of the point.
  await win.getByRole('list', { name: 'Conversation' }).waitFor();
  return { app, win };
}

test('all eight message kinds render from real rows served by the real Core', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-chat-'));
  await seedChat(userDataDir);
  const { app, win } = await openChat(userDataDir);

  try {
    // 1. text — markdown, as elements rather than escaped source.
    const conversation = win.getByRole('list', { name: 'Conversation' });
    await expect(conversation.getByText('small site')).toBeVisible();
    await expect(conversation.locator('strong', { hasText: 'small site' })).toBeVisible();
    await expect(conversation.locator('code', { hasText: 'recipes' })).toBeVisible();

    // 2. question — option chips, reachable by keyboard because they are
    //    real buttons in document order.
    const chips = win.getByRole('list', { name: 'Suggested answers' });
    await expect(chips.getByRole('button', { name: 'Just me' })).toBeVisible();
    await expect(chips.getByRole('button', { name: 'Anyone on the web' })).toBeVisible();

    // 3. brief — with its assumptions called out, per §14.2.
    const brief = win.getByRole('region', { name: 'Brief: Recipe site' });
    await expect(brief.getByText('A page listing recipes, readable on a phone.')).toBeVisible();
    await expect(brief.getByText(/Assumptions/)).toBeVisible();
    await expect(
      brief.getByText('Recipes are written by you, not submitted by visitors'),
    ).toBeVisible();

    // 4. plan — collapsible phases, task counts, assignees, estimated cost.
    const plan = win.getByRole('region', { name: 'Plan' });
    await expect(plan.getByText(/1 phase, 2 tasks/)).toBeVisible();
    await expect(plan.getByText('$2.14')).toBeVisible();
    // Collapsed by default; the tasks are there once it is opened.
    await plan.getByText(/Build the pages — 2 tasks/).click();
    await expect(plan.getByText('Ravi').first()).toBeVisible();

    // 5. report — and §11.5.1's rule, which is the one that would silently
    //    lie. An engine that reports no usage must never render $0.00.
    const report = win.getByRole('region', { name: 'Report' });
    await expect(report.getByText('The list page is up and shows every recipe.')).toBeVisible();
    await expect(report.getByText('cost not reported by this engine')).toBeVisible();
    await expect(report.getByText('$0.00')).toHaveCount(0);

    // 6. summary
    await expect(
      win.getByRole('region', { name: 'Phase complete: Build the pages' }),
    ).toBeVisible();

    // 7. error — CLAUDE.md: translate, never show raw engine output by
    //    default. Plain language, a concrete action, and the stack trace
    //    present but not shown.
    const errorCard = win.getByRole('region', { name: 'Error' });
    await expect(errorCard.getByText(/could not start work because/)).toBeVisible();
    await expect(errorCard.getByRole('button', { name: 'Open engine settings' })).toBeVisible();
    await expect(errorCard.getByText('ENOENT')).toBeHidden();
    await errorCard.getByText('Show technical detail').click();
    await expect(errorCard.getByText(/spawn claude ENOENT/)).toBeVisible();

    // 8. checkpoint — §9.2's anatomy, rendered from the live checkpoints
    //    slice. Invariant #8 is the assertion that matters: EVERY option
    //    shows its consequence.
    const card = win.getByRole('region', { name: 'Decision: Where should the recipes live?' });
    const options = card.getByRole('list', { name: 'Options' }).getByRole('listitem');
    await expect(options).toHaveCount(2);
    for (const option of await options.all()) {
      await expect(option.getByText(/If you choose this:/)).toBeVisible();
    }
    await expect(card.getByText('Recommended')).toHaveCount(1);
    // §9.2: "at most one option is recommended, and the Director explains
    // WHY" — the badge without its reason is not a recommendation.
    await expect(
      card.getByText(/Nothing to run, and you edit them like any document/),
    ).toBeVisible();
    // The timer states the consequence of NOT answering (§9.5, invariant #7).
    await expect(card.getByText(/If you do not answer, Bureau will choose/)).toBeVisible();
    // §9.2: free text is always accepted alongside the options.
    await expect(card.getByLabel(/Something else\?/)).toBeVisible();

    // §9.4's surface 2, reading the same slice as the card above.
    await expect(win.getByLabel('1 waiting for you')).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('answering the checkpoint card removes it, because the Core says it is no longer pending', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-chat-answer-'));
  await seedChat(userDataDir);
  const { app, win } = await openChat(userDataDir);

  try {
    const card = win.getByRole('region', { name: 'Decision: Where should the recipes live?' });
    await expect(card).toBeVisible();

    // Standing rule 3's cousin: assert the badge is THERE before asserting
    // it goes. A `toHaveCount(0)` on a selector that never matched anything
    // passes for the wrong reason, and the anchored pattern below is new.
    await expect(win.getByLabel(/^\d+ waiting for you$/)).toHaveCount(1);

    // Free text alongside the option, both sent — §9.2's "users often have
    // a third answer" applies even when they do pick one.
    await card.getByLabel(/Something else\?/).fill('and keep them in the repo');
    await card.getByRole('button', { name: /Plain files in the project/ }).click();

    // The card goes because a pushed `checkpoints` patch says it is no
    // longer pending — the view never removes it on its own. That is the
    // whole live-state path: real answer -> real event -> real broadcast ->
    // real store -> this.
    await expect(card).toBeHidden({ timeout: 10_000 });
    await expect(win.getByText('This decision has already been handled.')).toBeVisible();

    // §9.4's "all reflecting one piece of state", checked on both surfaces
    // that carry a count rather than on one loose phrase.
    //
    // This assertion used to be `getByLabel(/waiting for you/)` with a
    // count of 0, which worked while the tab badge was the only thing
    // saying those words. AUDIT M0–M2 #7 gave the title bar a real bell,
    // and its zero state reads "Nothing is waiting for you." — matching
    // that regex while meaning the opposite. Anchoring it to the badge's
    // own `N waiting for you` shape keeps the original intent (nothing
    // claims a pending count) and the bell gets its own positive check,
    // so the test now proves both surfaces agree instead of proving one
    // string is absent.
    await expect(win.getByLabel(/^\d+ waiting for you$/)).toHaveCount(0);
    await expect(win.getByTitle(/Nothing is waiting for you/)).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
