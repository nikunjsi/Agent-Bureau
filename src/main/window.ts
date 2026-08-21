import { app, BrowserWindow } from 'electron';
import path from 'node:path';

const DEV_SERVER_URL = 'http://localhost:5173';

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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

  win.once('ready-to-show', () => win.show());

  const url = app.isPackaged ? 'app://bureau/index.html' : DEV_SERVER_URL;
  void win.loadURL(url);

  return win;
}
