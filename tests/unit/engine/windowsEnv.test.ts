import { describe, expect, it } from 'vitest';
import {
  WINDOWS_BASE_ENV_ALLOWLIST,
  buildEmployeeTempEnv,
  buildWindowsBaseEnv,
} from '../../../src/main/engine/windowsEnv';

/**
 * §7.6 (M3 correction): pins the Windows base-environment allowlist exactly,
 * per the explicit requirement that adding a variable later must mean
 * deliberately editing this test, not quietly widening an object literal —
 * this is a security boundary.
 */
describe('WINDOWS_BASE_ENV_ALLOWLIST (§7.6)', () => {
  it('is exactly the documented set — no more, no less', () => {
    expect(WINDOWS_BASE_ENV_ALLOWLIST).toEqual([
      'SystemRoot',
      'SystemDrive',
      'windir',
      'ComSpec',
      'PATHEXT',
    ]);
  });
});

describe('buildWindowsBaseEnv', () => {
  it('pulls only the allowlisted keys from the given environment', () => {
    const fakeRealEnv = {
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      windir: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      // Deliberately NOT allowlisted — must not leak through.
      ANTHROPIC_API_KEY: 'sk-should-never-appear',
      USERPROFILE: 'C:\\Users\\someone',
    };
    const result = buildWindowsBaseEnv(fakeRealEnv);
    expect(result).toEqual({
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      windir: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    });
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(result).not.toHaveProperty('USERPROFILE');
  });

  it('omits a key entirely rather than defaulting it, when the real env does not have it', () => {
    const result = buildWindowsBaseEnv({ SystemRoot: 'C:\\Windows' });
    expect(result).toEqual({ SystemRoot: 'C:\\Windows' });
    expect(result).not.toHaveProperty('ComSpec');
  });
});

describe('buildEmployeeTempEnv', () => {
  it('points TEMP and TMP at <stateDir>/tmp, not the real system temp', () => {
    const result = buildEmployeeTempEnv('C:\\Users\\test\\.bureau\\state\\quinn');
    expect(result.TEMP).toBe('C:\\Users\\test\\.bureau\\state\\quinn\\tmp');
    expect(result.TMP).toBe('C:\\Users\\test\\.bureau\\state\\quinn\\tmp');
  });
});
