import { Notification } from 'electron';
import { allKnownWindows } from '../windowRegistry';
import type { CheckpointNotifier } from './surfacing';

/**
 * §9.4's fourth surface, and the only part of it that touches Electron.
 *
 * Deliberately thin to the point of having no decisions in it: whether to
 * notify is `surfacing.ts`'s call (unfocused **and** blocking **and** the
 * user's `general.notifications` switch), and this only knows how to read
 * focus and show a toast. Everything testable is on the other side of the
 * seam; everything here is proven inside the real packaged app by
 * `smoketest/notifications.ts`, because nothing in the vitest suites can
 * import `electron` at all.
 *
 * **Focus is genuinely available from M2's shell** — checked before this
 * was built rather than assumed: `windowRegistry.ts` has tracked every
 * window `createMainWindow()` created since M2, for the IPC router's own
 * "is this sender one of ours" check, and exports `allKnownWindows()`.
 *
 * The other half of making a Windows toast actually appear is §18.2's
 * named trap — `app.setAppUserModelId()` must match the installed
 * shortcut's AppUserModelID or notifications silently never show. That call
 * already exists at the top of `main/index.ts`; it is not re-made here,
 * because two places setting an app-wide identity is the shape standing
 * rule 6 names.
 */
export function isAnyWindowFocused(): boolean {
  return allKnownWindows().some((win) => !win.isDestroyed() && win.isFocused());
}

export function createDesktopNotifier(): CheckpointNotifier {
  return {
    isAnyWindowFocused,
    notify: ({ title, body }) => {
      // Not an error case: Windows can genuinely have notifications off at
      // the OS level, and a checkpoint is still surfaced by every other
      // route. Constructing a Notification when unsupported is what throws.
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    },
  };
}
