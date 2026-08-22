import { describe, expect, it } from 'vitest';
import { resolveRealExecutable } from '../../../src/main/engine/resolveRealExecutable';

const REAL_NPM_SHIM_CONTENT = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;

describe('resolveRealExecutable (M3 session 2 — spawn EINVAL / shell-injection finding)', () => {
  it('a non-.cmd path is returned unchanged, no file read attempted', () => {
    const result = resolveRealExecutable('C:\\tools\\claude.exe', () => {
      throw new Error('should not be called');
    });
    expect(result).toBe('C:\\tools\\claude.exe');
  });

  it('parses the real npm shim format (%dp0%-relative) and resolves to an existing sibling .exe', () => {
    const cmdPath = 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd';
    const expectedExe =
      'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const result = resolveRealExecutable(
      cmdPath,
      () => REAL_NPM_SHIM_CONTENT,
      (candidate) => candidate === expectedExe,
    );
    expect(result).toBe(expectedExe);
  });

  it('falls back to the .cmd path if the extracted .exe does not actually exist', () => {
    const cmdPath = 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd';
    const result = resolveRealExecutable(
      cmdPath,
      () => REAL_NPM_SHIM_CONTENT,
      () => false, // nothing exists
    );
    expect(result).toBe(cmdPath);
  });

  it('falls back to the .cmd path if the file cannot be read at all', () => {
    const cmdPath = 'C:\\tools\\claude.cmd';
    const result = resolveRealExecutable(
      cmdPath,
      () => {
        throw new Error('ENOENT');
      },
      () => true,
    );
    expect(result).toBe(cmdPath);
  });

  it('falls back to the .cmd path if the shim content does not match the expected shape', () => {
    const cmdPath = 'C:\\tools\\weird.cmd';
    const result = resolveRealExecutable(
      cmdPath,
      () => '@echo off\r\nnode "%~dp0\\weird.js" %*\r\n', // a .js-backed shim, not .exe — a real, different npm shim shape
      () => true,
    );
    expect(result).toBe(cmdPath);
  });

  it('handles an absolute-path-quoted shim (not %dp0%-relative)', () => {
    const cmdPath = 'C:\\tools\\other.cmd';
    const exePath = 'D:\\SomewhereElse\\real.exe';
    const result = resolveRealExecutable(
      cmdPath,
      () => `@echo off\r\n"${exePath}" %*\r\n`,
      (candidate) => candidate === exePath,
    );
    expect(result).toBe(exePath);
  });
});
