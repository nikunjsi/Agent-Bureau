import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RegistryHive = 'HKCU' | 'HKLM';

const REGISTRY_KEY_PATH: Record<RegistryHive, string> = {
  HKCU: 'HKCU\\Environment',
  HKLM: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
};

// Matches a line like:  "    Path    REG_EXPAND_SZ    C:\foo;C:\bar with spaces"
// Directory entries can contain single spaces ("Program Files"), so this
// captures everything after the type token rather than splitting on
// whitespace.
const PATH_VALUE_LINE = /^\s*Path\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/im;

/**
 * §15.4 step 1: reads the `Path` value out of `HKCU\Environment` or the
 * machine environment key, exactly as `reg query` reports it — expansion of
 * any `%VAR%` tokens inside a REG_EXPAND_SZ value is the caller's job (see
 * `expandEnvTokens` in resolvedPath.ts), kept separate so this function
 * stays a pure "what does the registry say" read with nothing to get wrong
 * about *which* environment supplies the expansion.
 *
 * Returns null if the key/value does not exist (a real, unremarkable state
 * — not every machine has ever had a user-level Path override) or `reg`
 * itself is unavailable. Never throws — this is detection, not a hard
 * requirement.
 */
export async function readRegistryPathValue(hive: RegistryHive): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', REGISTRY_KEY_PATH[hive], '/v', 'Path']);
    const match = PATH_VALUE_LINE.exec(stdout);
    return match?.[2] ? match[2].trim() : null;
  } catch {
    // Non-zero exit (value/key not found) or `reg` missing entirely.
    return null;
  }
}
