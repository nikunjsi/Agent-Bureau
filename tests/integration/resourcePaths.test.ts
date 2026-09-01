import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, waitForFile } from '../helpers/packagedApp';

/**
 * TRAP #3 (M4 session 2 prompt): dev resolves bureau-hook.js/bureau-tools.js
 * relative to the app path; packaged resolves relative to
 * process.resourcesPath — the two are never interchangeable, and this is
 * the one gate (real packaged exe, real app.isPackaged===true) that
 * exercises the packaged branch at all. Spawns the real packaged exe with
 * BUREAU_SMOKETEST=resourcepaths (src/main/smoketest/resourcePaths.ts).
 */
describe('bureau-hook.js/bureau-tools.js resolve correctly inside the packaged app (TRAP #3)', () => {
  let child: ChildProcess | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    child?.kill();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('both scripts resolve under process.resourcesPath and genuinely exist on disk', async () => {
    const exe = resolvePackagedExePath();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-smoketest-resourcepaths-'));
    const outFile = path.join(tmpDir, 'result.json');

    child = spawn(exe, [], {
      env: { ...process.env, BUREAU_SMOKETEST: 'resourcepaths', BUREAU_SMOKETEST_OUT: outFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const raw = await waitForFile(outFile, 20_000);
    const result = JSON.parse(raw) as {
      ok: boolean;
      error?: string;
      hookPath?: string;
      toolsPath?: string;
      pricingYamlPath?: string;
      pricingEngineCount?: number;
    };

    expect(result.ok, result.error).toBe(true);
    expect(result.hookPath).toMatch(/bureau-hook\.js$/);
    expect(result.toolsPath).toMatch(/bureau-tools\.js$/);
    // §28 M6 item 7 — the real build-pipeline gap found this session
    // (electron-builder.yml/build.mjs neither shipped pricing.yaml before
    // this): proves the packaged app can genuinely find AND parse it, not
    // just that a path string looks plausible.
    expect(result.pricingYamlPath).toMatch(/pricing\.yaml$/);
    expect(result.pricingEngineCount).toBeGreaterThan(0);
  });
});
