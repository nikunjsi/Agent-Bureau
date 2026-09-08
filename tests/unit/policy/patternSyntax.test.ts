import { describe, expect, it } from 'vitest';
import { validateToolPatternSyntax } from '../../../src/shared/policy/patternSyntax';
import { parseToolPattern } from '../../../src/shared/policy/patternGrammar';

describe('validateToolPatternSyntax (§6.7 check 4)', () => {
  it('accepts every pattern shape §6.5 and §11.3 actually use', () => {
    const real = [
      'Read(**)',
      'Write(${worktree}/**)',
      'Bash(npm *|pnpm *|yarn *|pytest *|python *|node *)',
      'Bash(git *)',
      'Task',
      '*',
      'mcp__*__spawn_*',
      'Write(**)|Edit(**)|MultiEdit(**)',
      'Read(${home}/.ssh/**)',
    ];
    for (const pattern of real) {
      expect(validateToolPatternSyntax(pattern), pattern).toEqual([]);
    }
  });

  // This is the whole reason the file exists. Demonstrated, not asserted in
  // a comment: the real parser accepts the malformed pattern silently.
  it('catches an unclosed paren that parseToolPattern accepts without complaint', () => {
    const malformed = 'Bash(rm *';
    expect(parseToolPattern(malformed)).toEqual([{ tool: 'Bash(rm *', argGlob: null }]);
    expect(validateToolPatternSyntax(malformed)).toEqual(['unbalanced parentheses in "Bash(rm *"']);
  });

  it('catches a stray closing paren', () => {
    expect(validateToolPatternSyntax('Bash rm *)')).toHaveLength(1);
  });

  it('catches empty terms from a doubled or trailing separator', () => {
    expect(validateToolPatternSyntax('Read(**)||Write(**)')[0]).toContain('empty term');
    expect(validateToolPatternSyntax('Read(**)|')[0]).toContain('empty term');
  });

  it('catches a term that is balanced but still not TOOL or TOOL(argglob)', () => {
    // `(**)` has no tool name; `A(b)c` has trailing junk. Both balance, so
    // only the shape check finds them.
    expect(validateToolPatternSyntax('(**)')[0]).toContain('not TOOL or TOOL(argglob)');
    expect(validateToolPatternSyntax('Read(**)x')[0]).toContain('not TOOL or TOOL(argglob)');
  });

  it('catches empty parentheses, which match only the empty argument', () => {
    const errors = validateToolPatternSyntax('Bash()');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('empty parentheses');
  });

  it('rejects an empty or whitespace-only pattern', () => {
    expect(validateToolPatternSyntax('')).toEqual(['pattern is empty']);
    expect(validateToolPatternSyntax('   ')).toEqual(['pattern is empty']);
  });

  it('reports one error per bad term rather than stopping at the first', () => {
    expect(validateToolPatternSyntax('Read(**)||Write()')).toHaveLength(2);
  });
});
