import { describe, expect, it } from 'vitest';
import { parseMergeTreeOutput } from '../../../src/main/workspace/mergeTree';

// Real captured output from `git merge-tree --write-tree` (git 2.55.0),
// against a real throwaway repo, run during M5 part 2 planning — not
// synthesized from memory. See the plan file's D2 for the setup.

const REAL_CLEAN_OUTPUT = '91ea438b768cbcc3cb652485c7c5219e741166bf\n';

const REAL_CONFLICT_OUTPUT = [
  '038115cac3f8caa00f730c06b169f770c5c7dd20',
  '100644 8a205e8dc3e7c7914d69c3e900f2e944d77bb100 1\tshared.txt',
  '100644 5defb68ecf3805e96cd62c793f7f5a1adb541073 2\tshared.txt',
  '100644 72d4773fb859619360dbc2bab05fbc7ec3e47d31 3\tshared.txt',
  '',
  'Auto-merging shared.txt',
  'CONFLICT (content): Merge conflict in shared.txt',
  '',
].join('\n');

describe('parseMergeTreeOutput (real captured `git merge-tree --write-tree` output)', () => {
  it('a clean merge (exit 0): just the resulting tree SHA', () => {
    const result = parseMergeTreeOutput(REAL_CLEAN_OUTPUT, 0);
    expect(result).toEqual({ clean: true, treeSha: '91ea438b768cbcc3cb652485c7c5219e741166bf' });
  });

  it('a real conflict (exit 1): tree SHA, one conflict entry with all three stages, and the human-readable messages', () => {
    const result = parseMergeTreeOutput(REAL_CONFLICT_OUTPUT, 1);
    expect(result.clean).toBe(false);
    if (result.clean) throw new Error('unreachable');
    expect(result.treeSha).toBe('038115cac3f8caa00f730c06b169f770c5c7dd20');
    expect(result.conflicts).toEqual([
      {
        path: 'shared.txt',
        base: { mode: '100644', sha: '8a205e8dc3e7c7914d69c3e900f2e944d77bb100' },
        ours: { mode: '100644', sha: '5defb68ecf3805e96cd62c793f7f5a1adb541073' },
        theirs: { mode: '100644', sha: '72d4773fb859619360dbc2bab05fbc7ec3e47d31' },
      },
    ]);
    expect(result.messages).toEqual(['Auto-merging shared.txt', 'CONFLICT (content): Merge conflict in shared.txt']);
  });

  it('multiple conflicting files produce one conflict entry each', () => {
    const output = [
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      '100644 1111111111111111111111111111111111111111 1\ta.txt',
      '100644 2222222222222222222222222222222222222222 2\ta.txt',
      '100644 3333333333333333333333333333333333333333 3\ta.txt',
      '100644 4444444444444444444444444444444444444444 2\tb.txt',
      '100644 5555555555555555555555555555555555555555 3\tb.txt',
      '',
      'Auto-merging a.txt',
      'CONFLICT (content): Merge conflict in a.txt',
      'Auto-merging b.txt',
      'CONFLICT (content): Merge conflict in b.txt',
    ].join('\n');
    const result = parseMergeTreeOutput(output, 1);
    if (result.clean) throw new Error('unreachable');
    expect(result.conflicts).toHaveLength(2);
    const bEntry = result.conflicts.find((c) => c.path === 'b.txt');
    // b.txt was added independently on both sides — no common ancestor,
    // so no stage-1 (base) entry, which the parser must not invent.
    expect(bEntry?.base).toBeNull();
    expect(bEntry?.ours).not.toBeNull();
    expect(bEntry?.theirs).not.toBeNull();
  });
});
