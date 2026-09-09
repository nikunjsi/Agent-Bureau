import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';
import { seedChat, seedParkedEmployee } from './fixtures/chatSeed';

/**
 * §14.2's composer and §28 M9 item 7's accessibility pass, against the
 * **real packaged app**.
 *
 * Every message asserted below is written by the real `chat.send` handler
 * into a real database, read back through the real `chat.listMessages`,
 * over the real preload, into the real store. No component is rendered
 * with hand-built props — a component test would prove the component and
 * not the path (standing rule 1).
 *
 * What is seeded is the *conversation the user types into*, by the
 * production writer, for the same reason `chat.spec.ts` seeds one: nothing
 * creates a conversation before M11's project intake or M13's wizard.
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
  await win.getByRole('list', { name: 'Conversation' }).waitFor();
  return { app, win };
}

test('typing a message sends it, and it comes back from the Core', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-compose-'));
  await seedChat(userDataDir);
  const { app, win } = await openChat(userDataDir);

  try {
    const box = win.getByLabel('Message the Director');
    await expect(box).toBeVisible();

    // §14.2: Shift+Enter is a newline, not a send. Checked FIRST, because
    // if Enter were bound wrongly this would already have sent.
    await box.fill('First line');
    await box.press('Shift+Enter');
    await box.type('second line');
    await expect(box).toHaveValue('First line\nsecond line');
    await expect(
      win.getByRole('list', { name: 'Conversation' }).getByText('First line'),
    ).toBeHidden();

    // §14.2: Enter sends.
    await box.press('Enter');

    // It appears because the CORE wrote it and sent it back — there is no
    // optimistic append anywhere in the store (invariant #11). The box
    // clearing is the same signal.
    const conversation = win.getByRole('list', { name: 'Conversation' });
    await expect(conversation.getByText('second line')).toBeVisible({ timeout: 10_000 });
    await expect(box).toHaveValue('');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('a slash command is answered by Bureau itself, as a system message', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-slash-e2e-'));
  await seedChat(userDataDir);
  const { app, win } = await openChat(userDataDir);

  try {
    const box = win.getByLabel('Message the Director');
    await box.fill('/help');
    await box.press('Enter');

    const conversation = win.getByRole('list', { name: 'Conversation' });
    // §17.2: "The parsed command is echoed into the conversation as a
    // `system` message." Author label and content, both from the real row.
    await expect(conversation.getByText('Bureau').last()).toBeVisible({ timeout: 10_000 });
    await expect(conversation.getByText(/handled by Bureau itself/)).toBeVisible();
    await expect(conversation.getByText(/stop every running employee/)).toBeVisible();

    // §17.2's other half: an unrecognised slash is ordinary text, so it
    // renders as the USER's message rather than an error or a system echo.
    await box.fill('check /tmp/foo.log please');
    await box.press('Enter');
    await expect(conversation.getByText('check /tmp/foo.log please')).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('an attachment outside the workspace is refused in plain language, and nothing is sent', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-attach-e2e-'));
  await seedChat(userDataDir);
  const { app, win } = await openChat(userDataDir);

  try {
    await win.getByRole('button', { name: 'Attach' }).click();
    await win.getByLabel(/Full path to a file/).fill('C:\\Users\\someone\\.ssh\\id_rsa');
    await win.getByRole('button', { name: 'Add file' }).click();
    await expect(win.getByRole('list', { name: 'Attached files' })).toContainText('id_rsa');

    const box = win.getByLabel('Message the Director');
    await box.fill('Have a look at this.');
    await box.press('Enter');

    // §14.6: what happened, why, and what to do — from the Core, in the
    // main process. The composer itself validates nothing.
    await expect(win.getByRole('alert')).toContainText(/outside your Bureau workspace/i, {
      timeout: 10_000,
    });
    // And the message is NOT in the transcript: the refusal is total.
    await expect(
      win.getByRole('list', { name: 'Conversation' }).getByText('Have a look at this.'),
    ).toBeHidden();
    // The text is kept, because a refused send must not eat what was typed.
    await expect(box).toHaveValue('Have a look at this.');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('answering a question chip sends its label as a real message', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-chips-'));
  await seedChat(userDataDir);
  const { app, win } = await openChat(userDataDir);

  try {
    const chips = win.getByRole('list', { name: 'Suggested answers' });
    const chip = chips.getByRole('button', { name: 'Just me' });
    // §14.2: "chips are keyboard-navigable". Focused and activated with the
    // keyboard alone, not clicked — a real button in document order is
    // what makes that true.
    await chip.focus();
    await expect(chip).toBeFocused();
    await chip.press('Enter');

    // It became an ordinary message, not a fourth handler: answering a
    // question IS sending one.
    await expect(
      win.getByRole('list', { name: 'Conversation' }).getByText('Just me', { exact: true }).last(),
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

/**
 * §14.7: **status is never conveyed by colour alone — icon plus label,
 * always.**
 *
 * The check is done with every colour in the app forcibly flattened to
 * black on white, which is the only way to assert the property rather than
 * assert around it: a screenshot comparison would pass on a page whose
 * states differ only in hue, and reading class names would test the
 * stylesheet rather than what a person can distinguish.
 *
 * **The third state, `streaming`, is asserted in `chatAborted.spec.ts`
 * instead**, and the reason is the product being right rather than a gap:
 * §5.1 requires `reconcile()` to mark any row still `streaming` from before
 * the app started as `aborted`, and it does — so a `streaming` row cannot
 * survive the app booting on it, and no fixture can produce one here. That
 * spec makes a genuinely live one, with a real separate process streaming
 * into an already-running app.
 */
test('interrupted and complete are distinguishable with all colour removed', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-monochrome-'));
  const { abortedMessageId, completeMessageId } = await seedChat(userDataDir);
  const { app, win } = await openChat(userDataDir);

  try {
    await win.addStyleTag({
      content: `* { color: #000 !important; background: #fff !important;
                    border-color: #000 !important; fill: #000 !important; }`,
    });

    const row = (id: string) => win.locator(`li[data-message-id="${id}"]`);

    // Interrupted says so, in a sentence. This is the state the gate line
    // exists for: a truncated reply that READS as a finished answer is the
    // failure, and the marker is the only thing preventing it.
    await expect(row(abortedMessageId)).toContainText(/interrupted and is incomplete/i);
    // And complete carries neither claim — its distinguishing feature is
    // the absence of both, which is still not a colour.
    await expect(row(completeMessageId)).not.toContainText('typing');
    await expect(row(completeMessageId)).not.toContainText(/interrupted/i);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('the whole send path is reachable by keyboard alone, with visible focus', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-keyboard-'));
  await seedChat(userDataDir);
  const { app, win } = await openChat(userDataDir);

  try {
    // §14.7: "full keyboard navigation with visible focus rings". Tab
    // until the composer has focus, rather than clicking into it — if it
    // were not in the tab order this would never terminate.
    const box = win.getByLabel('Message the Director');
    for (
      let i = 0;
      i < 40 && !(await box.evaluate((el) => el === document.activeElement));
      i += 1
    ) {
      await win.keyboard.press('Tab');
    }
    await expect(box).toBeFocused();

    // The ring is a real rendered outline, not just a class: read the
    // computed style so a removed `focus-visible` rule fails here.
    const outlineWidth = await box.evaluate((el) => getComputedStyle(el).outlineWidth);
    expect(outlineWidth).not.toBe('0px');

    await win.keyboard.type('typed without a mouse');
    await win.keyboard.press('Enter');
    await expect(
      win.getByRole('list', { name: 'Conversation' }).getByText('typed without a mouse'),
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

/**
 * **The way back from `/pause`, on screen.**
 *
 * `slashCommandsLive.test.ts` proves `employees.resumeEmployee` works in
 * both states — with a live Supervisor, and with none at all after a
 * restart. What it cannot see is whether a person can *reach* it, and that
 * is the whole point: before this session `/pause` would have been the first
 * user action with no reachable undo, and `Supervisor.pause()`'s own comment
 * claimed otherwise on the strength of a function nothing called.
 *
 * A banner that does not render is that bug, exactly.
 */
test('a stopped employee is announced, and Resume is reachable and works', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-paused-'));
  await seedChat(userDataDir);
  const { name } = await seedParkedEmployee(userDataDir);
  const { app, win } = await openChat(userDataDir);

  try {
    // A named region, so a screen reader announces what this strip is
    // before reading it — and so this assertion is about the banner rather
    // than about the employee bar, which also names Ravi.
    const banner = win.getByRole('region', { name: 'Stopped employees' });
    // Icon plus words, and the two things a person needs to know: who, and
    // that closing Bureau will not fix it (§14.7, §14.6).
    await expect(banner).toContainText('1 person is stopped');
    await expect(banner).toContainText(name);
    // The seeded employee has no `resume_at` — a manual pause never sets one
    // — so nothing will ever un-park them, and the banner says exactly that.
    // A quota-parked employee WOULD come back on its own, and gets a
    // different sentence; claiming one for both is what the first draft did.
    await expect(banner).toContainText('Closing Bureau does not restart them');
    await expect(banner).not.toContainText('would start again on their own');

    const resume = banner.getByRole('button', { name: 'Resume' });
    // Keyboard-reachable, like everything else in this view.
    await resume.focus();
    await expect(resume).toBeFocused();
    await resume.press('Enter');

    // The banner goes because the CORE says they are no longer parked — the
    // roster comes back on a pushed snapshot, and nothing here updates
    // optimistically (invariant #11).
    await expect(banner).toBeHidden({ timeout: 10_000 });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
