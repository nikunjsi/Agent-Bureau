import { test, expect, _electron as electron } from '@playwright/test';
import { resolvePackagedExePath } from '../helpers/packagedApp';
import type { HealthResult } from '../../src/shared/ipc/health';

/**
 * §28 M0 gate 2: the PACKAGED app must open a window that loads through the
 * custom `app://` protocol — dev mode proves nothing here. Also exercises
 * the whole renderer -> preload -> main IPC bridge (window.bureau.system.health())
 * inside that real packaged window, which doubles as proof the contextBridge
 * surface from src/preload actually works once asar'd and unpacked.
 */
test('packaged app opens a window loaded via app://', async () => {
  const app = await electron.launch({ executablePath: resolvePackagedExePath() });

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  expect(win.url()).toMatch(/^app:\/\//);

  const health = await win.evaluate<HealthResult>(() => window.bureau.system.health());
  expect(health.ok).toBe(true);
  expect(health.platform).toBe('win32');

  await expect(win.getByRole('heading', { name: 'Bureau' })).toBeVisible();

  await app.close();
});
