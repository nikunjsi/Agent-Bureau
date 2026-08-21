import path from 'node:path';

/**
 * §7.6's "nothing inherited" is correct in intent (no user secrets, no
 * ambient API keys, no inherited agent config) but wrong taken completely
 * literally on Windows: spawning without basic OS plumbing set breaks
 * binaries in ways that look like adapter faults, not environment gaps.
 * This is the full, deliberate exception list — nothing else is ever
 * inherited from the real process environment. See §7.6 in
 * docs/BUILD-SPEC.md for why each entry is here.
 *
 * A single named constant, pinned by a test (tests/unit/engine/windowsEnv.
 * test.ts) that asserts it equals exactly this set. Adding a variable later
 * requires deliberately editing that test, not quietly widening an object
 * literal — this is a security boundary and it should be hard to erode by
 * accident.
 */
export const WINDOWS_BASE_ENV_ALLOWLIST = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
] as const;

export type WindowsBaseEnvKey = (typeof WINDOWS_BASE_ENV_ALLOWLIST)[number];

/**
 * Pulls only the allowlisted keys from the real process environment. A
 * missing key is simply omitted, never defaulted — a machine without one of
 * these set has a bigger problem than Bureau can paper over, and silently
 * inventing a value would hide that.
 */
export function buildWindowsBaseEnv(
  realEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of WINDOWS_BASE_ENV_ALLOWLIST) {
    const value = realEnv[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * TEMP/TMP are deliberately NOT on the allowlist above — they are
 * synthesized per employee, pointed at `<stateDir>/tmp`, never inherited
 * from the user's real system temp. That keeps scratch files inside
 * Bureau's own state boundary rather than a directory other processes
 * share, and sidesteps the ambiguity around what `${bureau_state}` means in
 * §11.3's permission grammar (never precisely defined there) by using the
 * one path that is already unambiguous and load-bearing elsewhere in §7.6:
 * the employee's own `stateDir`, same as `HOME`/`CLAUDE_CONFIG_DIR`.
 *
 * Callers are responsible for creating the directory before spawn — this
 * function only computes the path.
 */
export function buildEmployeeTempEnv(stateDir: string): { TEMP: string; TMP: string } {
  const tempDir = path.join(stateDir, 'tmp');
  return { TEMP: tempDir, TMP: tempDir };
}
