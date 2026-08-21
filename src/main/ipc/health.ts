import { app, ipcMain } from 'electron';
import { HealthResultSchema, type HealthResult } from '../../shared/ipc/health';

function buildHealthResult(): HealthResult {
  return HealthResultSchema.parse({
    ok: true,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: 'win32',
  });
}

export function registerHealthHandler(): void {
  ipcMain.handle('system.health', () => buildHealthResult());
}
