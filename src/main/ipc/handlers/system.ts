import { app, shell } from 'electron';
import path from 'node:path';
import { createBackup } from '../../db/backup';
import { ipcOk } from '../../../shared/ipc/envelope';
import { System as SystemSchemas } from '../../../shared/ipc/schemas/system';
import { stub, type Handler } from './types';

function buildHealthResult() {
  return {
    ok: true as const,
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: 'win32' as const,
  };
}

export const systemHandlers: Record<string, Handler> = {
  health: () => ipcOk({ item: buildHealthResult() }),
  openPath: async (input) => {
    const { path: target } = SystemSchemas.openPath.input.parse(input);
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return ipcOk({ ok: true as const });
  },
  openExternal: async (input) => {
    const { url } = SystemSchemas.openExternal.input.parse(input);
    // §4.2: external links only via shell.openExternal after validating
    // the URL scheme — z.string().url() (schemas/system.ts) already
    // rejects anything that isn't a well-formed URL; restrict further to
    // http(s) so this can never be used to launch an arbitrary protocol
    // handler.
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Refusing to open a non-http(s) URL: ${parsed.protocol}`);
    }
    await shell.openExternal(url);
    return ipcOk({ ok: true as const });
  },
  restart: () => {
    app.relaunch();
    app.exit(0);
    return ipcOk({ ok: true as const });
  },
  backupDb: async (_input, ctx) => {
    const backupPath = await createBackup(ctx.db, ctx.dbPaths.backupsDir);
    return ipcOk({ path: backupPath });
  },
  compactDb: (_input, ctx) => {
    ctx.db.exec('VACUUM');
    return ipcOk({ ok: true as const });
  },
  openDataFolder: async (_input, ctx) => {
    const dataDir = path.dirname(ctx.dbPaths.dbPath);
    const err = await shell.openPath(dataDir);
    if (err) throw new Error(err);
    return ipcOk({ ok: true as const });
  },
  // supportBundle needs the redactor (§11, M6) to be safe to export at
  // all; checkUpdate needs electron-updater (M15, §18.2); scanFolder is
  // §15.2's wizard-owned scanner (M13) — implementable standalone, but
  // building it now would be starting M13's work early.
  supportBundle: stub('M6'),
  checkUpdate: stub('M15'),
  scanFolder: stub('M13'),
};
