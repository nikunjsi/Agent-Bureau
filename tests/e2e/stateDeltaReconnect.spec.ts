import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';

/**
 * §17.2: "The renderer holds no authoritative state. It hydrates from
 * `stateDelta` and re-hydrates fully on reconnect." Driven end to end
 * through real UI interaction (open Settings, toggle a value, reload the
 * window, reopen Settings) rather than reaching into the Zustand store's
 * internals — proving the whole path (write → main persists → reload →
 * `did-finish-load` fires → a fresh full `stateDelta` → the store
 * re-hydrates → the UI reflects it), not just the reducer in isolation
 * (that unit-level proof is tests/unit/renderer/bureauStore.test.ts).
 *
 * `win.reload()` is this test's stand-in for "kill and restore the
 * channel mid-stream" — Electron doesn't have a separate IPC "channel" to
 * sever independently of the renderer's own page lifecycle, so a real
 * reload (the same thing a crash-and-recover or a manual refresh
 * triggers) is the actual reconnect event `wireStateDeltaOnLoad`
 * (src/main/ipc/stateDelta.ts) is built to handle.
 */
test('renderer re-hydrates fully after a reload, reflecting what was actually persisted', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-statedelta-'));
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.getByRole('heading', { name: /^Bureau/ }).waitFor();

    const checkboxId = 'general.notifications';

    await win.getByRole('button', { name: 'Open settings' }).click();
    const checkbox = win.locator(`[id="${checkboxId}"]`);
    await checkbox.waitFor();
    const before = await checkbox.isChecked();

    await checkbox.setChecked(!before);
    // settings.set fires on the checkbox's change event and is awaited by
    // the component before it would show an error — give the real IPC
    // round trip a moment rather than asserting immediately.
    await win.waitForTimeout(300);
    await win.getByRole('button', { name: 'Close settings' }).click();

    // The actual reconnect event under test.
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await win.getByRole('heading', { name: /^Bureau/ }).waitFor();

    await win.getByRole('button', { name: 'Open settings' }).click();
    const checkboxAfterReload = win.locator(`[id="${checkboxId}"]`);
    await checkboxAfterReload.waitFor();
    await expect(checkboxAfterReload).toBeChecked({ checked: !before });

    // And it matches what main actually persisted, not just what the UI
    // happens to show — the independent, authoritative confirmation.
    const persisted = await win.evaluate(() => window.bureau.settings.get({}));
    expect(persisted.ok).toBe(true);
    if (persisted.ok) {
      expect(persisted.data.item['general.notifications']).toBe(!before);
    }
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
