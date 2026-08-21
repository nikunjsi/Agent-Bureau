import type { BrowserWindow, WebContents } from 'electron';

/**
 * Every window `createMainWindow()` created — the router's own "is this
 * sender actually one of ours" check (§17.2/§4.2) reads this. A `Set`, not
 * a single window, since a later milestone may open a second window
 * (support bundle preview, etc.) without this needing to change.
 */
const knownWindows = new Set<BrowserWindow>();

export function registerWindow(win: BrowserWindow): void {
  knownWindows.add(win);
  win.once('closed', () => knownWindows.delete(win));
}

export function isKnownSender(sender: WebContents): boolean {
  for (const win of knownWindows) {
    if (!win.isDestroyed() && win.webContents.id === sender.id) return true;
  }
  return false;
}

export function allKnownWindows(): BrowserWindow[] {
  return [...knownWindows];
}
