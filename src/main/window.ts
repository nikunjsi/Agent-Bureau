import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerWindow } from './windowRegistry';

const DEV_SERVER_URL = 'http://localhost:5173';

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // §14.1: "Minimum window 1280×800; below that the floor auto-collapses."
    // AUDIT M0–M2 #17 — the initial size was here from M2 and the minimum
    // never was, so the window could be dragged to any size at all and the
    // three-pane layout simply crushed.
    //
    // Both halves of that sentence are needed and the second is not
    // redundant: a minimum is a request the window manager can decline.
    // On a display narrower than 1280 logical pixels, or under heavy OS
    // scaling, Electron hands back a window below its own minimum — which
    // is precisely when the floor has to get out of the way on its own
    // (`FloorPane`'s width observer).
    minWidth: 1280,
    minHeight: 800,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
    },
  });

  // §4.2 hard rule: window.open is denied by default, unconditionally.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  registerWindow(win);

  win.once('ready-to-show', () => win.show());

  const url = app.isPackaged ? 'app://bureau/index.html' : DEV_SERVER_URL;
  void win.loadURL(url);

  return win;
}
