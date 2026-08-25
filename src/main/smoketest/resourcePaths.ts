import { app } from 'electron';
import { existsSync } from 'node:fs';
import { resolveBureauHookScriptPath, resolveBureauToolsScriptPath } from '../engine/resourceScripts';
import { writeResult } from './result';

/**
 * TRAP #3 (M4 session 2 prompt): ELECTRON_RUN_AS_NODE differs dev vs
 * packaged — dev resolves relative to the app path, packaged resolves
 * relative to `process.resourcesPath`, and the two are never
 * interchangeable. Run only when `BUREAU_SMOKETEST=resourcepaths`, from
 * the real packaged exe (`app.isPackaged` is genuinely true there, unlike
 * under any dev/test run) — the one thing that actually exercises the
 * `app.isPackaged` branch resourceScripts.ts's two functions take.
 * Confirms both resolved paths are absolute, under process.resourcesPath,
 * and — the real proof, not just "the path looks right" — that a real
 * file actually exists there, extraResources having genuinely copied it.
 */
export async function runResourcePathsSmoketest(): Promise<void> {
  try {
    const hookPath = resolveBureauHookScriptPath();
    const toolsPath = resolveBureauToolsScriptPath();

    const failures: string[] = [];
    if (!app.isPackaged) failures.push('app.isPackaged is false — this smoketest only means something from a real packaged exe');
    if (!hookPath.startsWith(process.resourcesPath)) failures.push(`bureau-hook.js path is not under process.resourcesPath: ${hookPath}`);
    if (!toolsPath.startsWith(process.resourcesPath)) failures.push(`bureau-tools.js path is not under process.resourcesPath: ${toolsPath}`);
    if (!existsSync(hookPath)) failures.push(`bureau-hook.js does not exist at the resolved path: ${hookPath}`);
    if (!existsSync(toolsPath)) failures.push(`bureau-tools.js does not exist at the resolved path: ${toolsPath}`);

    if (failures.length > 0) {
      writeResult({ ok: false, error: failures.join('; '), hookPath, toolsPath });
      app.exit(1);
      return;
    }

    writeResult({ ok: true, hookPath, toolsPath, resourcesPath: process.resourcesPath });
    app.exit(0);
  } catch (error) {
    writeResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    app.exit(1);
  }
}
