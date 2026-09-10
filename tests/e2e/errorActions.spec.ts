import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';

/**
 * AUDIT M0–M2 #16 — §14.6's *"concrete next action (a button where
 * possible)"*, end to end in the real packaged app.
 *
 * `IpcErrorAction` was correct, exhaustively modelled and rendered
 * **nowhere** for nine milestones. `errorNoticeIsTheOnlyRenderer.test.ts`
 * proves no call site drops it any more; that is a scan, and a scan cannot
 * tell you a button appears or that pressing it does anything.
 *
 * This is the whole chain in one assertion:
 *
 *   `company.hire` on a database with no company row
 *     -> `requireCompanyId` returns NOT_FOUND with `action: open_settings`
 *     -> the envelope crosses the real preload bridge
 *     -> `ErrorNotice` reads the action and renders a button
 *     -> pressing it opens the real settings dialog
 *
 * A fresh user-data dir is what makes it reachable: no company exists
 * until the setup wizard makes one, which is exactly the state the Core's
 * `open_settings` action is for.
 */
test('an error action from the Core becomes a working button', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-erroraction-'));
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.getByRole('heading', { name: /^Bureau/ }).waitFor();

    // The settings dialog is not open to begin with.
    await expect(win.getByRole('dialog', { name: /settings/i })).toHaveCount(0);

    await win.getByRole('button', { name: '+ Hire' }).click();

    const notice = win.getByRole('alert');
    await expect(notice).toBeVisible();
    // Plain language — and, just as importantly, NOT the raw internals.
    await expect(notice).toContainText('No company has been set up yet');
    await expect(notice).not.toContainText('NOT_FOUND');
    await expect(notice).not.toContainText('Error:');

    // The half that was missing entirely.
    const button = notice.getByRole('button', { name: /open settings/i });
    await expect(button, '§14.6s next action, rendered as a real control').toBeVisible();

    await button.click();
    await expect(
      win.getByRole('dialog', { name: /settings/i }),
      'the action button has to DO the thing, not just look like it would',
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
