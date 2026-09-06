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

/** §11.5.1 — `resources/pricing.yaml`, same dev-vs-packaged split as the
 * two functions above (`scripts/build.mjs`'s `copyPricingYaml` + `
 * electron-builder.yml`'s own `extraResources` entry are what put a real
 * file at each of these two paths — see both). */
export function resolvePricingYamlPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'pricing.yaml');
  }
  return path.join(app.getAppPath(), 'dist', 'resources', 'pricing.yaml');
}

/**
 * §6.2 — the BUNDLED pack root, same dev-vs-packaged split as everything
 * above (`scripts/build.mjs`'s `copyPacks` + `electron-builder.yml`'s own
 * `extraResources` entry are what put real files at each of these two
 * paths).
 *
 * Read-only, and distinct from the USER pack root (`getPacksDir(baseDir)`
 * → `%APPDATA%/Bureau/packs/`), which is writable and is where
 * `packs.install` copies a user's own pack. Neither is the other, and a
 * user pack shadowing a bundled key is a validation error rather than a
 * silent override.
 *
 * Note the dev path is `dist/packs`, not `dist/resources/packs` — packs
 * are their own `extraResources` entry landing at `resourcesPath/packs`,
 * so the dev layout mirrors that rather than nesting under `resources/`.
 */
export function resolveBundledPacksDirPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'packs');
  }
  return path.join(app.getAppPath(), 'dist', 'packs');
}
