import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';

/**
 * AUDIT M0–M2 #17 — §14.1's *"Splitter is draggable and persisted"* and
 * *"Minimum window 1280×800; below that the floor auto-collapses"*.
 *
 * Both are listed as M2 build items (§28 M2 item 5) and neither existed:
 * `FloorPane` was a fixed `w-64` with no drag handler and no persistence,
 * and `window.ts` set an initial size and no minimum at all. Neither M2's
 * "Deviations" nor its "What's stubbed" section mentioned any of it —
 * the same shape as M7's four missing `role.yaml` columns, an item in an
 * enumerable list that was never built and never recorded.
 *
 * This is an e2e rather than a component test for the reason session 1
 * wrote down: **persistence and a window minimum are configurations, and
 * nothing in this repository used to assert that a configuration is in
 * force.** A component test could drag a mock and prove nothing about
 * whether the width survives a reload or whether the real `BrowserWindow`
 * refuses to shrink.
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

const floor = (win: Page) => win.getByRole('region', { name: 'Office floor' });
const splitter = (win: Page) => win.getByRole('separator', { name: /floor/i });

async function floorWidth(win: Page): Promise<number> {
  const box = await floor(win).boundingBox();
  if (box === null) throw new Error('the floor pane is not visible');
  return box.width;
}

test('the window refuses to shrink below §14.1s 1280x800', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-layout-min-'));
  const { app, win } = await launch(userDataDir);

  try {
    const minimum = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return w === undefined ? null : w.getMinimumSize();
    });
    expect(minimum, 'no minimum size is set at all').toEqual([1280, 800]);

    // And it is enforced, not merely declared: asking for less is refused
    // by the window itself.
    const afterShrink = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.setSize(900, 600);
      return w.getSize();
    });
    expect(afterShrink[0]).toBeGreaterThanOrEqual(1280);
    expect(afterShrink[1]).toBeGreaterThanOrEqual(800);
    expect(win).toBeTruthy();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('the splitter drags, and the width it lands on survives a reload', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-layout-drag-'));
  const { app, win } = await launch(userDataDir);

  try {
    const before = await floorWidth(win);
    const handle = splitter(win);
    await expect(handle, '§14.1s splitter does not exist').toBeVisible();

    const box = await handle.boundingBox();
    if (box === null) throw new Error('the splitter has no box');
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 10 });
    await win.mouse.up();

    const after = await floorWidth(win);
    expect(after, 'dragging the splitter changed nothing').toBeGreaterThan(before + 60);

    // §14.1 says "persisted", which is the half a drag handler alone does
    // not give you. A reload re-runs the whole renderer and re-hydrates
    // from the Core, so a width that survives it came from the database
    // rather than from component state.
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await win.getByRole('heading', { name: /^Bureau/ }).waitFor();
    await expect
      .poll(async () => Math.round(await floorWidth(win)), {
        message: 'the dragged width did not survive a reload — it is not persisted',
        timeout: 5_000,
      })
      .toBe(Math.round(after));
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('the floor auto-collapses when the window is narrower than the minimum', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-layout-collapse-'));
  const { app, win } = await launch(userDataDir);

  try {
    await expect(floor(win)).toBeVisible();

    // §14.1 asks for both a minimum AND an auto-collapse below it, which
    // only makes sense because the minimum is not always honourable — a
    // display smaller than 1280 logical pixels, or heavy OS scaling, and
    // Electron hands you a window under its own minimum. Dropping the
    // minimum here reproduces exactly that machine, on this one.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.setMinimumSize(400, 300);
      w.setSize(1000, 700);
    });

    await expect(
      floor(win),
      'the floor stayed expanded in a window too narrow for it (§14.1)',
    ).toBeHidden();
    // Collapsed, not gone: the strip that brings it back is still there.
    await expect(win.getByRole('button', { name: /expand the floor/i })).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
