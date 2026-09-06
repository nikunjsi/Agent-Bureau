import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  resolveBureauHookScriptPath,
  resolveBureauToolsScriptPath,
  resolvePricingYamlPath,
  resolveBundledPacksDirPath,
} from '../engine/resourceScripts';
import { loadPricingYaml } from '../cost/pricingYaml';
import { loadPack } from '../packs/loadPack';
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
    // M6 session 2 — a real build-pipeline gap found while writing this:
    // neither electron-builder.yml's extraResources nor scripts/build.mjs
    // shipped a non-.ts resource file before pricing.yaml needed one. Both
    // fixed alongside resolvePricingYamlPath() itself; this is the same
    // "real file genuinely exists, not just a plausible-looking path"
    // proof the hook/tools paths already get, extended to cover it, plus
    // an actual parse (not just existsSync) — a copied-but-corrupt file
    // would pass existsSync and fail here instead.
    const pricingYamlPath = resolvePricingYamlPath();
    // M7 — packs are the third non-.ts resource and the first that is a
    // whole DIRECTORY TREE rather than one file. `extraResources` copying
    // a directory is a different code path from copying a file, and
    // `existsSync` on the root would pass for an empty one, so the check
    // below goes all the way to parsing a real pack out of it.
    const packsDir = resolveBundledPacksDirPath();

    const failures: string[] = [];
    if (!app.isPackaged) failures.push('app.isPackaged is false — this smoketest only means something from a real packaged exe');
    if (!hookPath.startsWith(process.resourcesPath)) failures.push(`bureau-hook.js path is not under process.resourcesPath: ${hookPath}`);
    if (!toolsPath.startsWith(process.resourcesPath)) failures.push(`bureau-tools.js path is not under process.resourcesPath: ${toolsPath}`);
    if (!pricingYamlPath.startsWith(process.resourcesPath)) failures.push(`pricing.yaml path is not under process.resourcesPath: ${pricingYamlPath}`);
    if (!existsSync(hookPath)) failures.push(`bureau-hook.js does not exist at the resolved path: ${hookPath}`);
    if (!existsSync(toolsPath)) failures.push(`bureau-tools.js does not exist at the resolved path: ${toolsPath}`);
    if (!existsSync(pricingYamlPath)) failures.push(`pricing.yaml does not exist at the resolved path: ${pricingYamlPath}`);
    let pricingEngineCount = 0;
    if (existsSync(pricingYamlPath)) {
      try {
        pricingEngineCount = Object.keys(loadPricingYaml(pricingYamlPath).engines).length;
        if (pricingEngineCount === 0) failures.push('pricing.yaml parsed but has zero engines');
      } catch (err) {
        failures.push(`pricing.yaml exists but failed to parse: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!packsDir.startsWith(process.resourcesPath)) failures.push(`packs dir is not under process.resourcesPath: ${packsDir}`);
    if (!existsSync(packsDir)) failures.push(`bundled packs dir does not exist at the resolved path: ${packsDir}`);
    let bundledRoleCount = 0;
    if (existsSync(packsDir)) {
      // Parses a real pack rather than trusting the directory exists: a
      // tree copied without its `prompts/` or with a mangled encoding
      // passes existsSync and fails here instead.
      const engineeringDir = path.join(packsDir, 'engineering');
      const loaded = loadPack(engineeringDir);
      if (loaded.pack === null) {
        failures.push(`bundled engineering pack does not load: ${loaded.errors.join('; ')}`);
      } else {
        bundledRoleCount = loaded.pack.roles.length;
        if (bundledRoleCount === 0) failures.push('bundled engineering pack loaded but has zero roles');
        for (const role of loaded.pack.roles) {
          const promptPath = path.join(engineeringDir, role.system_prompt_path);
          if (!existsSync(promptPath)) failures.push(`bundled prompt missing: ${promptPath}`);
        }
      }
    }

    if (failures.length > 0) {
      writeResult({ ok: false, error: failures.join('; '), hookPath, toolsPath, pricingYamlPath, packsDir });
      app.exit(1);
      return;
    }

    writeResult({
      ok: true,
      hookPath,
      toolsPath,
      pricingYamlPath,
      pricingEngineCount,
      packsDir,
      bundledRoleCount,
      resourcesPath: process.resourcesPath,
    });
    app.exit(0);
  } catch (error) {
    writeResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    app.exit(1);
  }
}
