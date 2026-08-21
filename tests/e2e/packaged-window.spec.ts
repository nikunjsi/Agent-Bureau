import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath } from '../helpers/packagedApp';
import type { HealthResult } from '../../src/shared/ipc/health';

/**
 * §28 M0 gate 2: the PACKAGED app must open a window that loads through the
 * custom `app://` protocol — dev mode proves nothing here. Also exercises
 * the whole renderer -> preload -> main IPC bridge (window.bureau.system.health())
 * inside that real packaged window, which doubles as proof the contextBridge
 * surface from src/preload actually works once asar'd and unpacked.
 *
 * Since M1, launching the real app also opens a real database at
 * `app.getPath('userData')` — `--user-data-dir` points that at a throwaway
 * temp directory instead of the developer's real `%APPDATA%\Bureau`, which
 * Electron would use by default. Without this, every local e2e run leaves
 * a real bureau.db/activity.jsonl behind on whoever's machine runs it.
 */
test('packaged app opens a window loaded via app://', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-e2e-userdata-'));
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    expect(win.url()).toMatch(/^app:\/\//);

    const health = await win.evaluate<HealthResult>(() => window.bureau.system.health());
    expect(health.ok).toBe(true);
    expect(health.platform).toBe('win32');

    await expect(win.getByRole('heading', { name: 'Bureau' })).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
