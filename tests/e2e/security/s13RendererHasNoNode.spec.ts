import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../../helpers/packagedApp';

/**
 * §11.7 S13 (`renderer_has_no_node`) — release-blocking, gates M2 (§28).
 * "window.require, process, and ipcRenderer are all undefined in the
 * renderer." Driven against the real packaged app, not dev mode — the
 * whole reason this class of bug is dangerous is that it can look fine
 * in dev and only leak in the packaged build's real sandbox.
 *
 * This test alone does not prove the *guard* works — it would pass
 * identically if `sandbox`/`nodeIntegration`/`contextIsolation` had never
 * been set at all, since Electron's own defaults already deny Node
 * access. The mutation proof (see this file's own note below and the M2
 * session record) is what actually distinguishes "we configured this
 * correctly" from "Electron's defaults happen to cover us."
 */
test('S13: window.require, process, and ipcRenderer are all undefined in the renderer', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-s13-'));
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const leaks = await win.evaluate(() => ({
      hasRequire: typeof (window as unknown as { require?: unknown }).require !== 'undefined',
      hasProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined',
      hasIpcRenderer:
        typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer !== 'undefined',
    }));

    expect(leaks.hasRequire, 'window.require must be undefined in the renderer').toBe(false);
    expect(leaks.hasProcess, 'window.process must be undefined in the renderer').toBe(false);
    expect(leaks.hasIpcRenderer, 'window.ipcRenderer must be undefined in the renderer').toBe(
      false,
    );

    // The allow-listed surface is still there — this isn't just "nothing
    // works", it's specifically "only the intended bridge works."
    const hasBureauApi = await win.evaluate(() => typeof window.bureau === 'object');
    expect(hasBureauApi).toBe(true);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
