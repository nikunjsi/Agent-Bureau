import { describe, expect, it } from 'vitest';
import {
  compileGlob,
  globMatch,
  matchToolPattern,
  matchToolPatternWithVariables,
  parseToolPattern,
  splitTopLevel,
  WILDCARD_TOOL_PATTERN,
} from '../../../src/shared/policy/patternGrammar';
import type { PolicyVariables } from '../../../src/shared/policy/types';

const PATH_OPTS = { pathSemantics: true, caseInsensitive: true } as const;
const NON_PATH_OPTS = { pathSemantics: false, caseInsensitive: false } as const;

const NO_VARS: PolicyVariables = { worktree: null, project: null, home: null, bureau_state: null };

describe('splitTopLevel (§11.3 pattern grammar)', () => {
  it('splits on the separator only outside parens', () => {
    expect(splitTopLevel('Write(**)|Edit(**)|MultiEdit(**)', '|')).toEqual([
      'Write(**)',
      'Edit(**)',
      'MultiEdit(**)',
    ]);
  });

  it('does not split a term whose own argglob contains the separator', () => {
    expect(splitTopLevel('Bash(git commit *|git push *)', '|')).toEqual([
      'Bash(git commit *|git push *)',
    ]);
  });
});

describe('parseToolPattern', () => {
  it('parses a bare tool with no argglob', () => {
    expect(parseToolPattern('Task')).toEqual([{ tool: 'Task', argGlob: null }]);
  });

  it('parses a single TOOL(argglob) term', () => {
    expect(parseToolPattern('Write(**)')).toEqual([{ tool: 'Write', argGlob: '**' }]);
  });

  it('parses multiple alternated terms, one of them a bare tool', () => {
    expect(parseToolPattern('Task|Agent|Spawn|Dispatch|mcp__*__spawn_*')).toEqual([
      { tool: 'Task', argGlob: null },
      { tool: 'Agent', argGlob: null },
      { tool: 'Spawn', argGlob: null },
      { tool: 'Dispatch', argGlob: null },
      { tool: 'mcp__*__spawn_*', argGlob: null },
    ]);
  });
});

describe('compileGlob — path semantics', () => {
  it('"*" matches within one path segment only', () => {
    const re = compileGlob('c:/worktree/*', PATH_OPTS);
    expect(re.test('c:/worktree/file.txt')).toBe(true);
    expect(re.test('c:/worktree/sub/file.txt')).toBe(false);
  });

  it('"**" matches across segments', () => {
    const re = compileGlob('c:/worktree/**', PATH_OPTS);
    expect(re.test('c:/worktree/sub/deep/file.txt')).toBe(true);
  });
});

describe('compileGlob — non-path semantics (Bash / MCP JSON)', () => {
  it('a single "*" still matches text containing "/" — no path-segment concept in a command line', () => {
    const re = compileGlob('git commit *', NON_PATH_OPTS);
    expect(re.test('git commit -m "fix path/to/file"')).toBe(true);
  });

  it('"**" behaves identically to "*" here', () => {
    expect(compileGlob('git commit **', NON_PATH_OPTS).test('git commit -m "x/y"')).toBe(true);
  });
});

describe('globMatch — internal "|" alternation inside one argglob', () => {
  it('matches any of the alternatives', () => {
    const opts = NON_PATH_OPTS;
    const alt = 'git commit *|git push *|git reset --hard *|git rebase *';
    expect(globMatch(alt, 'git push origin main', opts)).toBe(true);
    expect(globMatch(alt, 'git status', opts)).toBe(false);
  });
});

describe('matchToolPattern — case sensitivity (proven trap, carried forward)', () => {
  it('"read" (lowercase) is not "Read"', () => {
    expect(matchToolPattern('Read(**)', 'read', 'c:/x', PATH_OPTS)).toBe(false);
    expect(matchToolPattern('Read(**)', 'Read', 'c:/x', PATH_OPTS)).toBe(true);
  });
});

describe('WILDCARD_TOOL_PATTERN — deny.system_paths\u2019 own shape (no tool_pattern in the spec YAML)', () => {
  it('matches any tool name when the pattern is the wildcard token', () => {
    expect(matchToolPattern(WILDCARD_TOOL_PATTERN, 'Read', 'c:/x', PATH_OPTS)).toBe(true);
    expect(matchToolPattern(WILDCARD_TOOL_PATTERN, 'Bash', 'anything', NON_PATH_OPTS)).toBe(true);
    expect(matchToolPattern(WILDCARD_TOOL_PATTERN, 'AnyFutureTool', '{}', NON_PATH_OPTS)).toBe(
      true,
    );
  });
});

describe('matchToolPatternWithVariables — §23.3\u2019s own example', () => {
  it('expands ${worktree} in an argglob when set', () => {
    const vars: PolicyVariables = {
      worktree: 'c:/wt/quinn',
      project: null,
      home: null,
      bureau_state: null,
    };
    expect(
      matchToolPatternWithVariables(
        'Write(${worktree}/docs/**)',
        'Write',
        'c:/wt/quinn/docs/readme.md',
        vars,
        PATH_OPTS,
      ),
    ).toBe(true);
    expect(
      matchToolPatternWithVariables(
        'Write(${worktree}/docs/**)',
        'Write',
        'c:/wt/other/docs/readme.md',
        vars,
        PATH_OPTS,
      ),
    ).toBe(false);
  });

  it('an unset variable makes the alternative referencing it never match — not substituted with an empty string', () => {
    // If '' were substituted, this would become "/docs/**" — a real,
    // accidental absolute-root pattern. It must instead simply never match.
    expect(
      matchToolPatternWithVariables(
        'Write(${worktree}/docs/**)',
        'Write',
        '/docs/readme.md',
        NO_VARS,
        PATH_OPTS,
      ),
    ).toBe(false);
    expect(
      matchToolPatternWithVariables(
        'Write(${worktree}/docs/**)',
        'Write',
        'c:/anything',
        NO_VARS,
        PATH_OPTS,
      ),
    ).toBe(false);
  });
});
