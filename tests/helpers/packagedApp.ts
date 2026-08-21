import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Deliberately not derived from this file's own location: Vitest (ESM,
// `import.meta.url`) and Playwright's default TS transform (CJS, no
// `import.meta`) can't agree on one way to do that from a file shared by
// both runners. Both are always invoked from the repo root (see the
// `test:integration`/`test:e2e` scripts), so process.cwd() is simpler and
// works under either.
const ROOT_DIR = process.cwd();

/**
 * Absolute path to the packaged (unpacked) app produced by
 * `npm run package` (`electron-builder --dir`). Every integration/e2e test
 * in this repo exercises the real packaged binary, never dev mode — per
 * §28 M0, dev mode proves nothing about the failures these tests exist to
 * catch.
 */
export function resolvePackagedExePath(): string {
  const exePath = path.join(ROOT_DIR, 'dist-package', 'win-unpacked', 'Bureau.exe');
  if (!existsSync(exePath)) {
    throw new Error(
      `Packaged app not found at ${exePath}. Run "npm run package" before running this test.`,
    );
  }
  return exePath;
}

/**
 * Checks whether a process with the given PID currently exists, using
 * `tasklist` rather than `process.kill(pid, 0)` for an unambiguous answer
 * on Windows.
 */
export function isProcessAlive(pid: number): boolean {
  const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
  });
  return output.includes(`"${pid}"`);
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollIntervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return predicate();
}

export async function waitForFile(filePath: string, timeoutMs: number): Promise<string> {
  const ok = await waitUntil(() => existsSync(filePath), timeoutMs, 200);
  if (!ok) {
    throw new Error(`Timed out waiting for ${filePath} to appear`);
  }
  // Give the writer a moment to finish flushing.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return readFile(filePath, 'utf8');
}
