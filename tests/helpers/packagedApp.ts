import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
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
  assertPackagedAppIsNotStale(exePath);
  return exePath;
}

/**
 * The environment to spawn the packaged exe with.
 *
 * **`ELECTRON_RUN_AS_NODE` must be stripped, and this is not theoretical.**
 * VS Code sets `ELECTRON_RUN_AS_NODE=1` in its integrated terminal, so
 * every test here that spawned `Bureau.exe` with a plain `{...process.env}`
 * silently ran it as **plain Node with no script argument** — which prints
 * nothing and exits 0. The visible symptom is "Timed out waiting for
 * result.json to appear", 20 seconds later, pointing at a perfectly good
 * packaged app. Three smoketests and every Playwright spec failed this way
 * before the cause was found (M7).
 *
 * CI does not set it, which is exactly why it went unnoticed: this is a
 * "works in CI, mysteriously broken locally" trap, and the local run is
 * the one this project actually relies on for re-verification.
 *
 * The variable is Bureau's own mechanism too (§7.10 launches bureau-hook /
 * bureau-tools with `process.execPath` + `ELECTRON_RUN_AS_NODE=1`), so an
 * inherited one is genuinely ambiguous rather than obviously wrong — all
 * the more reason to strip it explicitly at the one place tests build an
 * env for the real app.
 */
export function packagedAppEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  // Defined-only: Playwright's `electron.launch({ env })` requires
  // `Record<string, string>`, and an inherited `undefined` value is
  // meaningless to a child process anyway.
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, extra);
  delete env['ELECTRON_RUN_AS_NODE'];
  return env;
}

/**
 * AUDIT #14 — a stale packaged app fails loudly instead of silently
 * passing.
 *
 * Every integration/e2e test here exercises only this binary, so a build
 * older than the source it is supposed to contain means the whole run
 * proves something about code that is no longer in the tree. CI never hits
 * this (it packages immediately before testing), but a local
 * re-verification session — this project's recurring habit, and the whole
 * point of a gate re-run — can silently validate a stale binary. The audit
 * caught exactly that: the packaged app predated 28 source files including
 * `policyEvaluator.ts`, `circuitBreaker.ts`, `redactor.ts`,
 * `secretBroker.ts` and `employeeCommit.ts`, and 13.5 minutes of green
 * integration evidence was nearly recorded against it.
 *
 * Same family as the `ELECTRON_RUN_AS_NODE` trap: an environmental
 * precondition that silently invalidates results. Memory is not a gate.
 */
export function assertPackagedAppIsNotStale(exePath: string): void {
  const builtAtMs = statSync(exePath).mtimeMs;
  const newer = findSourceFilesNewerThan(builtAtMs);
  if (newer.length === 0) return;

  const shown = newer.slice(0, 10).map((f) => `  - ${path.relative(ROOT_DIR, f)}`).join('\n');
  const more = newer.length > 10 ? `\n  ...and ${newer.length - 10} more` : '';
  throw new Error(
    `The packaged app is STALE: ${newer.length} source file(s) are newer than ${path.relative(ROOT_DIR, exePath)} ` +
      `(built ${new Date(builtAtMs).toISOString()}).\n` +
      `Every integration/e2e test runs against this binary, so these results would describe code that is no longer in the tree.\n` +
      `Run "npm run package" and re-run.\n\nNewer than the build:\n${shown}${more}`,
  );
}

/** Source that is actually compiled into the packaged app. Tests and docs
 *  are deliberately excluded — editing a test does not stale the binary. */
const PACKAGED_SOURCE_DIRS = ['src', 'resources'] as const;

function findSourceFilesNewerThan(thresholdMs: number): string[] {
  const out: string[] = [];
  for (const dir of PACKAGED_SOURCE_DIRS) {
    walk(path.join(ROOT_DIR, dir), thresholdMs, out);
  }
  return out;
}

function walk(dir: string, thresholdMs: number, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // directory absent in this checkout — nothing to compare
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, thresholdMs, out);
      continue;
    }
    if (statSync(full).mtimeMs > thresholdMs) out.push(full);
  }
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
