import { app } from 'electron';
import path from 'node:path';

/**
 * §7.10/§18.1: `bureau-hook.js`/`bureau-tools.js` ship as plain JS files
 * under `extraResources`, run by Electron itself
 * (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`) — never a bundled second
 * Node runtime. Same dev-vs-packaged split as `jobObject.ts`'s own
 * `resolveDummyScriptPath` (§28 M0 gate 4), which established this exact
 * pattern first; TRAP #3 from the M4 session 2 prompt is precisely this —
 * dev mode resolves relative to the app path, packaged mode resolves
 * relative to `process.resourcesPath`, and the two are never
 * interchangeable. Both call sites (buildLaunchSpec, for the MCP config's
 * and the hook config's own `command`/`args`) go through these two
 * functions so there is exactly one place this split is expressed.
 */
export function resolveBureauToolsScriptPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'bureau-tools.js');
  }
  return path.join(app.getAppPath(), 'dist', 'resources', 'bin', 'bureau-tools.js');
}

export function resolveBureauHookScriptPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'bureau-hook.js');
  }
  return path.join(app.getAppPath(), 'dist', 'resources', 'bin', 'bureau-hook.js');
}
