import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Every Windows PowerShell spawn Bureau makes goes through this module
 * (M11 S1-21), for one reason: **a child `powershell.exe` inherits the
 * parent's `PSModulePath`, and a PowerShell 7 parent breaks it.**
 *
 * PowerShell 7 puts its own module folders first on `PSModulePath`. A
 * child Windows PowerShell 5.1 inherits that list, resolves a built-in
 * module to PS7's Core-only copy, and cannot load it:
 *
 * ```
 * Get-Acl : The 'Get-Acl' command was found in the module
 * 'Microsoft.PowerShell.Security', but the module could not be loaded.
 *     + FullyQualifiedErrorId : CouldNotAutoloadMatchingModule
 * ```
 *
 * GitHub Actions runs every step in PowerShell 7, which is why CI was red
 * for two attempts at S1-21; a user who starts Bureau from a PowerShell 7
 * terminal (VS Code with `pwsh` as its shell) gets the same. It is not a
 * runner quirk and it is not elevation.
 *
 * So the environment is not inherited blind: `PSModulePath` is set
 * explicitly to Windows PowerShell's own module directory and nothing
 * else, and the rest of the environment is passed through. Bureau never
 * loads a module from outside `System32`, so narrowing it costs nothing
 * and removes the whole class of failure.
 *
 * The executable is named by absolute path for the reason `whoami` is
 * (`tokens.ts`): PATH is not ours to trust.
 *
 * `env` is a parameter rather than a read of `process.env` so a test can
 * hand in a poisoned `PSModulePath` — the real defect, reproduced — without
 * mutating the environment of the process running the suite.
 */
export interface WindowsPowerShellSpawn {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/** Windows' own `System32`, from the environment it was given. */
export function windowsSystem32(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.SystemRoot ?? 'C:\\Windows', 'System32');
}

/**
 * The one place that decides how Bureau spawns PowerShell (standing rule
 * 6). Returns the spawn rather than performing it, so the two callers —
 * one async, one synchronous — share the decision without sharing an
 * execution style neither of them can use.
 */
export function windowsPowerShellSpawn(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsPowerShellSpawn {
  const v1 = path.join(windowsSystem32(env), 'WindowsPowerShell', 'v1.0');
  return {
    file: path.join(v1, 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
    env: withPsModulePath(env, path.join(v1, 'Modules')),
  };
}

/**
 * The environment, with `PSModulePath` replaced — **replaced**, not added
 * alongside.
 *
 * Windows environment variables are case-insensitive; a JavaScript
 * object's keys are not. `{ ...env, PSModulePath: x }` reads as a
 * replacement and is not one when the source spells the name differently:
 * the child is handed two variables, and the pre-existing spelling is the
 * one that wins. That is not hypothetical — Vitest's `process.env`
 * snapshot carries `PSMODULEPATH`, measured while building S1-21's tests,
 * and the "fix" was silently inert under it. A fix that can be defeated by
 * the casing of a variable name is not a fix.
 */
function withPsModulePath(env: NodeJS.ProcessEnv, value: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, v] of Object.entries(env)) {
    if (!/^psmodulepath$/i.test(key)) out[key] = v;
  }
  out.PSModulePath = value;
  return out;
}

/** Trimmed stdout. Throws what `execFile` throws — every caller here has
 *  its own fail-closed answer and none of them wants a swallowed error. */
export async function runWindowsPowerShell(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const spawn = windowsPowerShellSpawn(command, env);
  const { stdout } = await execFileAsync(spawn.file, [...spawn.args], {
    env: spawn.env,
    windowsHide: true,
  });
  return stdout.trim();
}

/** The synchronous twin, for the reconcile path, which is synchronous. */
export function runWindowsPowerShellSync(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const spawn = windowsPowerShellSpawn(command, env);
  return execFileSync(spawn.file, [...spawn.args], {
    encoding: 'utf8',
    env: spawn.env,
    windowsHide: true,
  }).trim();
}
