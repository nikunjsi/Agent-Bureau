import { app, Notification } from 'electron';
import { createMainWindow } from '../window';
import { allKnownWindows } from '../windowRegistry';
import { createDesktopNotifier, isAnyWindowFocused } from '../checkpoints/desktopNotifier';
import { writeResult } from './result';

/**
 * §9.4's desktop notification, proven inside the **real packaged app**.
 *
 * The decision — unfocused **and** `blocking` **and** the user's
 * `general.notifications` switch — is `surfacing.ts`'s, and the integration
 * suite drives it against a recording notifier. What that can never touch
 * is the half that needs Electron: reading window focus, and whether a
 * toast can actually be constructed and shown. Nothing in the vitest
 * suites can import `electron` at all.
 *
 * So this follows `resourcePaths.ts`'s precedent exactly: run the REAL
 * production functions (`createMainWindow`, `isAnyWindowFocused`,
 * `createDesktopNotifier().notify`) inside a genuinely packaged process
 * and report structured results. That is the difference between "window
 * focus is available from M2's shell" as a claim and as a fact.
 *
 * §18.2's own named trap sits underneath all of this: `app.setAppUserModelId()`
 * must match the installed shortcut's AppUserModelID or Windows toasts
 * silently never appear. `main/index.ts` makes that call at module scope,
 * so it has already run by the time any smoketest mode does. Electron
 * exposes no getter for it, so what is reported here is the observable
 * consequence — `Notification.isSupported()` and a real toast that does
 * not throw — rather than a re-read of the value.
 */
/**
 * Gives a requested focus change a bounded chance to land, then reports what
 * `isAnyWindowFocused()` — **the production function** — actually says.
 *
 * `win.focus()` and `win.blur()` are requests to the window manager, not
 * state changes. The original code called `win.blur()` and read focus on the
 * very next synchronous line, asking Windows a question it had not finished
 * answering; waiting for the window's own event is strictly better than
 * that. It is **not** sufficient, which is the point of the comment on
 * `focusedAfterBlur` in the test: Windows may keep a lone foreground window
 * focused with nowhere else to send focus, and then no `blur` event ever
 * arrives. Observed for real (M10, 2026-09-10) — `focusedAfterBlur: true`
 * inside the full integration suite, passing standalone, and still true
 * after waiting 2s for the event.
 *
 * Two properties, both load-bearing:
 *
 *  - **The value comes from `isAnyWindowFocused()`**, never from
 *    `win.isFocused()`. This smoketest exists to prove the production
 *    function reads real window state; reading the underlying Electron call
 *    instead would make the assertion touch a stand-in — standing rule 1,
 *    and the exact mistake this file caught me making.
 *  - **On timeout it returns the truth**, not the value we hoped for.
 */
async function settleFocus(
  win: Electron.BrowserWindow,
  wanted: boolean,
  timeoutMs = 2_000,
): Promise<boolean> {
  if (isAnyWindowFocused() === wanted) return wanted;

  return new Promise<boolean>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      win.off('focus', onSettled);
      win.off('blur', onSettled);
      resolve(isAnyWindowFocused());
    };
    const onSettled = (): void => {
      if (isAnyWindowFocused() === wanted) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    win.on('focus', onSettled);
    win.on('blur', onSettled);
  });
}

export async function runNotificationsSmoketest(): Promise<void> {
  try {
    const failures: string[] = [];

    if (!app.isPackaged) {
      failures.push(
        'app.isPackaged is false — this smoketest only means something from a real packaged exe',
      );
    }

    // The registry M2 built for the IPC router's "is this sender one of
    // ours" check is the same one focus is read from. Before a window
    // exists, "is anything focused" must be false, not a crash — the
    // surfacing tick can genuinely run in that window at startup.
    const focusedBeforeAnyWindow = isAnyWindowFocused();
    if (focusedBeforeAnyWindow) {
      failures.push('isAnyWindowFocused() was true before any window existed');
    }

    const win = createMainWindow();
    const knownWindowCount = allKnownWindows().length;
    if (knownWindowCount !== 1) {
      failures.push(`expected exactly one known window, got ${knownWindowCount}`);
    }

    // Both states, driven for real rather than asserted about: a window
    // that has been focused reports focused, and one that has been blurred
    // reports unfocused. §9.4's rule is entirely built on this returning
    // something true about the world.
    // `createMainWindow` shows on `ready-to-show`, which needs a loaded
    // document; this smoketest never registers the `app://` handler (that
    // is normal startup's job), so it shows the window itself rather than
    // waiting for a load that will not complete.
    win.show();
    win.focus();
    const focusedAfterFocus = await settleFocus(win, true);
    win.blur();
    const focusedAfterBlur = await settleFocus(win, false);

    // The deterministic half, and the one §9.4 actually rests on: with no
    // live window, "is anything focused" is false. That is a property of the
    // registry rather than of the desktop session, so unlike focus/blur it
    // is the same on every machine and is asserted below.
    win.destroy();
    const focusedAfterDestroy = isAnyWindowFocused();
    if (focusedAfterDestroy) {
      failures.push('isAnyWindowFocused() was true after the only window was destroyed');
    }
    const knownWindowsAfterDestroy = allKnownWindows().length;

    const notificationSupported = Notification.isSupported();

    // The real production notifier, on the real path, actually shown.
    // A toast during a CI run is harmless and does not block.
    let notifyThrew: string | null = null;
    try {
      createDesktopNotifier().notify({
        title: 'Bureau smoketest',
        body: 'A checkpoint notification would look like this.',
      });
    } catch (error) {
      notifyThrew = error instanceof Error ? error.message : String(error);
      failures.push(`createDesktopNotifier().notify() threw: ${notifyThrew}`);
    }

    const result = {
      ok: failures.length === 0,
      ...(failures.length > 0 ? { error: failures.join('; ') } : {}),
      focusedBeforeAnyWindow,
      focusedAfterFocus,
      focusedAfterBlur,
      focusedAfterDestroy,
      notificationSupported,
      notifyThrew,
      knownWindowCount,
      knownWindowsAfterDestroy,
    };

    writeResult(result);
    app.exit(failures.length === 0 ? 0 : 1);
  } catch (error) {
    writeResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    app.exit(1);
  }
}
