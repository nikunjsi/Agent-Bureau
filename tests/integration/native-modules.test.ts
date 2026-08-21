import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, waitForFile } from '../helpers/packagedApp';

/**
 * §28 M0 gate 3: better-sqlite3 and node-pty must load and work *inside the
 * packaged app* — i.e. rebuilt against Electron's ABI, not just present in
 * node_modules. This spawns the real packaged exe with BUREAU_SMOKETEST=native
 * (src/main/smoketest/nativeModules.ts) and asserts the result, rather than
 * eyeballing a launch.
 */
describe('native modules load inside the packaged app', () => {
  let child: ChildProcess | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    child?.kill();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('better-sqlite3 and node-pty both load and work', async () => {
    const exe = resolvePackagedExePath();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-smoketest-'));
    const outFile = path.join(tmpDir, 'result.json');

    child = spawn(exe, [], {
      env: { ...process.env, BUREAU_SMOKETEST: 'native', BUREAU_SMOKETEST_OUT: outFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const raw = await waitForFile(outFile, 20_000);
    const result = JSON.parse(raw) as { ok: boolean; error?: string };

    expect(result.ok, result.error).toBe(true);
  });
});
