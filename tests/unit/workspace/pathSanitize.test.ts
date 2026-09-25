import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  sanitizeEmployeeDirName,
  computeWorktreePath,
  assertNoWorktreePathCollision,
  InvalidEmployeeNameError,
  WorktreeNameCollisionError,
} from '../../../src/main/workspace/pathSanitize';

describe('sanitizeEmployeeDirName (trap e)', () => {
  it('lowercases and passes through a plain name unchanged', () => {
    expect(sanitizeEmployeeDirName('Quinn')).toBe('quinn');
  });

  it('strips anything outside [a-z0-9_-] and collapses/trims dashes', () => {
    expect(sanitizeEmployeeDirName('Quinn K. Patel!!')).toBe('quinn-k-patel');
    expect(sanitizeEmployeeDirName('  --Leading Trailing--  ')).toBe('leading-trailing');
  });

  it('throws InvalidEmployeeNameError when the name sanitizes to empty', () => {
    expect(() => sanitizeEmployeeDirName('!!!')).toThrow(InvalidEmployeeNameError);
  });

  it('rejects Windows reserved device names, case-insensitively, at any casing', () => {
    for (const reserved of ['CON', 'con', 'Nul', 'COM1', 'lpt9']) {
      expect(() => sanitizeEmployeeDirName(reserved), reserved).toThrow(InvalidEmployeeNameError);
    }
  });

  it('does NOT reject a name that merely contains a reserved word as a substring', () => {
    // "console" sanitizes to "console", not "con" — must not false-positive.
    expect(sanitizeEmployeeDirName('console')).toBe('console');
  });

  it('"Quinn" and "quinn" sanitize to the byte-identical string — this is what makes the collision loud, not silent', () => {
    expect(sanitizeEmployeeDirName('Quinn')).toBe(sanitizeEmployeeDirName('quinn'));
  });
});

describe('computeWorktreePath (trap d)', () => {
  it('always lives under <companyHome>/.bureau/worktrees/<name>, never under a project path', () => {
    const companyHome = 'C:\\Users\\test\\bureau-home';
    const result = computeWorktreePath(companyHome, 'Quinn');
    expect(result).toBe(path.join(companyHome, '.bureau', 'worktrees', 'quinn'));
    expect(result.startsWith(path.join(companyHome, '.bureau', 'worktrees'))).toBe(true);
  });
});

describe('assertNoWorktreePathCollision (trap e)', () => {
  it('throws WorktreeNameCollisionError when "Quinn" and "quinn" would compute to the same path', () => {
    const companyHome = 'C:\\Users\\test\\bureau-home';
    const existingPath = computeWorktreePath(companyHome, 'Quinn');
    const candidatePath = computeWorktreePath(companyHome, 'quinn');
    expect(() => assertNoWorktreePathCollision(candidatePath, [existingPath])).toThrow(
      WorktreeNameCollisionError,
    );
  });

  it('is case-insensitive even against an unsanitized existing path (defense in depth)', () => {
    expect(() =>
      assertNoWorktreePathCollision('C:\\home\\.bureau\\worktrees\\QUINN', [
        'c:\\home\\.bureau\\worktrees\\quinn',
      ]),
    ).toThrow(WorktreeNameCollisionError);
  });

  it('does not throw for genuinely distinct names', () => {
    const companyHome = 'C:\\Users\\test\\bureau-home';
    const existingPath = computeWorktreePath(companyHome, 'Quinn');
    const candidatePath = computeWorktreePath(companyHome, 'Wren');
    expect(() => assertNoWorktreePathCollision(candidatePath, [existingPath])).not.toThrow();
  });
});
