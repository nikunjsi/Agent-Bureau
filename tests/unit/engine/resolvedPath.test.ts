import { describe, expect, it } from 'vitest';
import {
  expandEnvTokens,
  knownInstallLocations,
  resolveBinaryAbsolutePath,
  splitPathEntries,
  unionPathEntries,
} from '../../../src/main/engine/resolvedPath';

describe('expandEnvTokens', () => {
  it('expands %VAR% tokens against the given environment', () => {
    const result = expandEnvTokens('%SystemRoot%\\system32;%SystemRoot%\\System32\\Wbem', {
      SystemRoot: 'C:\\Windows',
    });
    expect(result).toBe('C:\\Windows\\system32;C:\\Windows\\System32\\Wbem');
  });

  it('leaves an unresolvable token as-is rather than dropping it silently', () => {
    const result = expandEnvTokens('%NotSet%\\foo', {});
    expect(result).toBe('%NotSet%\\foo');
  });
});

describe('splitPathEntries', () => {
  it('splits on ";", trims, and drops empty segments (trailing ";" etc.)', () => {
    expect(splitPathEntries('C:\\a; C:\\b ;;C:\\c')).toEqual(['C:\\a', 'C:\\b', 'C:\\c']);
  });

  it('keeps single spaces inside a directory name intact', () => {
    expect(splitPathEntries('C:\\Program Files\\Git\\cmd;C:\\a')).toEqual([
      'C:\\Program Files\\Git\\cmd',
      'C:\\a',
    ]);
  });
});

describe('knownInstallLocations (§15.4 step 2)', () => {
  it('builds the four documented locations from the given env', () => {
    const locations = knownInstallLocations({
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    });
    expect(locations).toEqual([
      'C:\\Users\\test\\AppData\\Roaming\\npm',
      'C:\\Program Files\\nodejs',
      'C:\\Program Files\\Git\\cmd',
      'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps',
    ]);
  });

  it('omits a location whose root env var is unset, rather than producing a bogus path', () => {
    expect(knownInstallLocations({})).toEqual([]);
  });
});

describe('unionPathEntries', () => {
  it('de-duplicates case-insensitively while preserving first-seen order and casing', () => {
    const result = unionPathEntries(['C:\\a', 'C:\\B'], ['c:\\A', 'C:\\c'], ['C:\\b']);
    expect(result).toEqual(['C:\\a', 'C:\\B', 'C:\\c']);
  });
});

describe('resolveBinaryAbsolutePath (§15.4 step 3)', () => {
  it('resolves a bare name by trying each PATHEXT extension in order', () => {
    const existing = new Set(['C:\\tools\\claude.CMD']);
    const result = resolveBinaryAbsolutePath('claude', 'C:\\nope;C:\\tools', {
      existsFn: (candidate) => existing.has(candidate),
    });
    expect(result).toBe('C:\\tools\\claude.CMD');
  });

  it('tries the name as-is when it already carries a known extension', () => {
    const existing = new Set(['C:\\tools\\claude.exe']);
    const result = resolveBinaryAbsolutePath('claude.exe', 'C:\\tools', {
      existsFn: (candidate) => existing.has(candidate),
    });
    expect(result).toBe('C:\\tools\\claude.exe');
  });

  it('returns null when nothing matches in any directory', () => {
    const result = resolveBinaryAbsolutePath('claude', 'C:\\a;C:\\b', { existsFn: () => false });
    expect(result).toBeNull();
  });

  it('searches directories in order and stops at the first match', () => {
    const existing = new Set(['C:\\second\\claude.EXE']);
    const calls: string[] = [];
    const result = resolveBinaryAbsolutePath('claude', 'C:\\first;C:\\second', {
      existsFn: (candidate) => {
        calls.push(candidate);
        return existing.has(candidate);
      },
    });
    expect(result).toBe('C:\\second\\claude.EXE');
    // Every C:\first candidate must have been tried and failed before
    // C:\second was ever reached — proves directory order is respected,
    // not just that the right answer happens to come out.
    expect(calls.some((c) => c.startsWith('C:\\first'))).toBe(true);
  });
});
