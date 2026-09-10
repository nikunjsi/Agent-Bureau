import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../../helpers/packagedApp';

/**
 * Audit M0–M2 #12 — a sibling of `tests/integration/configurationIsInForce.test.ts`,
 * same class of gap: a declaration nothing asserted. It lives here rather
 * than there because these three values are only readable from a real
 * packaged main process.
 *
 * **S13 is blind to `sandbox: false`.** Confirmed by repackaging with
 * `sandbox: false` and running both: S13 passes, this fails. The preload
 * regains full Node in its own process while `window.require`, `process`
 * and `ipcRenderer` stay undefined in the main world, which is all S13
 * inspects. S13's own header admitted the gap and pointed at an
 * out-of-band mutation proof that is not in the repo.
 *
 * **One correction to that finding, because it matters for how the next
 * one of these is measured.** The audit reported the gap from a probe that
 * *deleted* the `sandbox: true` line. That mutation is inert on Electron
 * 43: sandboxing has defaulted ON since Electron 20, so the deleted-line
 * build still applies `sandbox: true` and this test passes against it,
 * correctly. The finding's substance survives — only the explicit
 * `sandbox: false` is a real weakening, and that is the mutation to use.
 * Same shape as audit #13's `foreign_keys`: a line whose deletion cannot
 * be observed, asserted for its value rather than its presence, so that a
 * genuine weakening still fails.
 *
 * **This does not replace S13 and does not change it.** S13 asserts the
 * behaviour a user is protected by; this asserts the configuration that
 * produces it. Both are needed, for the reason §28 M0 item 4 lists three
 * flags rather than one outcome: Electron's own defaults already deny most
 * of what S13 checks, so S13 alone cannot distinguish "Bureau configured
 * this correctly" from "Electron's defaults happen to cover us today".
 */
test('§28 M0 item 4: the window is created with all three webPreferences flags set', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-s13-prefs-'));
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // Read from the MAIN process — these are what Electron actually
    // applied to the window, not what the source says was requested.
    //
    // `getLastWebPreferences()` is present at runtime but absent from
    // Electron 43's `.d.ts`, hence the cast. `methodPresent` below is not
    // ceremony: if a future Electron drops the method, the cast would make
    // every value `undefined` and three `toBe` assertions would fail with
    // a misleading message about the flags rather than about the probe.
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const [first] = BrowserWindow.getAllWindows();
      if (first === undefined) return null;
      const wc = first.webContents as unknown as {
        getLastWebPreferences?: () => Record<string, unknown> | null;
      };
      const applied = wc.getLastWebPreferences?.() ?? null;
      return {
        methodPresent: typeof wc.getLastWebPreferences === 'function',
        contextIsolation: applied?.['contextIsolation'],
        nodeIntegration: applied?.['nodeIntegration'],
        sandbox: applied?.['sandbox'],
        windowCount: BrowserWindow.getAllWindows().length,
      };
    });

    expect(prefs, 'the packaged app must have opened a window').not.toBeNull();
    expect(prefs?.windowCount).toBeGreaterThan(0);
    expect(
      prefs?.methodPresent,
      'webContents.getLastWebPreferences() is how this test reads the applied flags — if Electron dropped it, this test needs a new probe, not a passing grade',
    ).toBe(true);

    expect(prefs?.contextIsolation, 'contextIsolation must be true (§28 M0 item 4)').toBe(true);
    expect(prefs?.nodeIntegration, 'nodeIntegration must be false (§28 M0 item 4)').toBe(false);
    // The one S13 cannot see. Setting it false gives the preload full Node
    // in the renderer process while leaving S13's main-world checks green
    // — verified by repackaging with `sandbox: false`.
    expect(prefs?.sandbox, 'sandbox must be true — S13 cannot see this one').toBe(true);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
