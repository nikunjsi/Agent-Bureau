import { describe, expect, it } from 'vitest';
import { parseWorktreeListPorcelain } from '../../../src/main/workspace/gitWorktree';

describe('parseWorktreeListPorcelain (M5 plan review fix #3)', () => {
  it('parses a single main-tree-only block (a fresh repo with no worktrees yet)', () => {
    const output = `worktree C:/repo\nHEAD abc123\nbranch refs/heads/main\n\n`;
    expect(parseWorktreeListPorcelain(output)).toEqual([
      { path: 'C:/repo', head: 'abc123', branch: 'main' },
    ]);
  });

  it("parses the main tree plus multiple worktrees, in git's own order (main first)", () => {
    const output = [
      'worktree C:/repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree C:/home/.bureau/worktrees/ravi',
      'HEAD def456',
      'branch refs/heads/bureau/ravi/unassigned',
      '',
      'worktree C:/home/.bureau/worktrees/priya',
      'HEAD def456',
      'branch refs/heads/bureau/priya/unassigned',
      '',
    ].join('\n');

    expect(parseWorktreeListPorcelain(output)).toEqual([
      { path: 'C:/repo', head: 'abc123', branch: 'main' },
      { path: 'C:/home/.bureau/worktrees/ravi', head: 'def456', branch: 'bureau/ravi/unassigned' },
      {
        path: 'C:/home/.bureau/worktrees/priya',
        head: 'def456',
        branch: 'bureau/priya/unassigned',
      },
    ]);
  });

  it('parses a detached worktree (branch stays null, never a bare "detached" string)', () => {
    const output = ['worktree C:/wt', 'HEAD abc123', 'detached', ''].join('\n');
    expect(parseWorktreeListPorcelain(output)).toEqual([
      { path: 'C:/wt', head: 'abc123', branch: null },
    ]);
  });

  it('tolerates locked/prunable annotation lines without losing the entry', () => {
    const output = [
      'worktree C:/wt',
      'HEAD abc123',
      'branch refs/heads/x',
      'locked reason text',
      '',
    ].join('\n');
    expect(parseWorktreeListPorcelain(output)).toEqual([
      { path: 'C:/wt', head: 'abc123', branch: 'x' },
    ]);
  });

  it('returns an empty array for empty output', () => {
    expect(parseWorktreeListPorcelain('')).toEqual([]);
  });

  it('flushes the final block even with no trailing blank line', () => {
    const output = 'worktree C:/repo\nHEAD abc123\nbranch refs/heads/main';
    expect(parseWorktreeListPorcelain(output)).toEqual([
      { path: 'C:/repo', head: 'abc123', branch: 'main' },
    ]);
  });
});
