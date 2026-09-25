import { describe, expect, it } from 'vitest';
import { evaluate } from '../../../src/shared/policy/evaluator';
import { IMMUTABLE_RULES } from '../../../src/shared/policy/immutableRules';
import { matchToolPattern } from '../../../src/shared/policy/patternGrammar';
import type { MatchContext, PolicyVariables } from '../../../src/shared/policy/types';

const VARS: PolicyVariables = {
  worktree: 'c:/wt/quinn',
  project: 'c:/projects/acme',
  home: 'c:/users/nikunj/bureau',
  bureau_state: 'c:/state/emp1',
};

function ctx(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    toolClass: 'command',
    canonicalPath: null,
    canonicalArg: '',
    domain: null,
    variables: VARS,
    effectiveAutonomy: 'autonomous',
    now: new Date(2026, 0, 1, 12),
    rawArgs: {},
    ...overrides,
  };
}

/**
 * §11.3 `deny.subagent_spawn`, AUDIT #5.
 *
 * The rule's pattern is `Task|Agent|Spawn|Dispatch|mcp__*__spawn_*`. The
 * bare names matched by exact string compare; the MCP term never matched
 * anything at all, because the grammar only globbed the ARGGLOB (inside
 * the parens), never the tool-name position — the asterisks in
 * `mcp__*__spawn_*` were compared literally.
 *
 * The names below are the real shape M4 established empirically against a
 * live agent (`mcp__<server>__<tool>`), not strings chosen to make a
 * pattern pass. §11.3: this rule "matters more than it looks" because
 * several engines ship a sub-agent tool by default.
 */
describe('deny.subagent_spawn actually matches real MCP-shaped sub-agent tools (AUDIT #5)', () => {
  const rule = IMMUTABLE_RULES.find((r) => r.id === 'deny.subagent_spawn');

  it('the rule still exists and still carries the MCP term', () => {
    expect(rule).toBeDefined();
    expect(rule?.toolPattern).toContain('mcp__*__spawn_*');
  });

  it.each([
    'mcp__foo__spawn_worker',
    'mcp__agents__spawn_agent',
    'mcp__some_server__spawn_subagent',
    'mcp__a__spawn_',
  ])('denies %s — an MCP server offering a sub-agent spawner', (tool) => {
    const verdict = evaluate(IMMUTABLE_RULES, tool, ctx());
    expect(verdict.effect).toBe('deny');
    expect(verdict.ruleId).toBe('deny.subagent_spawn');
  });

  it('still denies the bare engine-native names the rule also lists', () => {
    for (const tool of ['Task', 'Agent', 'Spawn', 'Dispatch']) {
      const verdict = evaluate(IMMUTABLE_RULES, tool, ctx());
      expect(verdict.effect, tool).toBe('deny');
      expect(verdict.ruleId, tool).toBe('deny.subagent_spawn');
    }
  });

  it('is denied by THIS rule specifically, not incidentally by the `other`-class default', () => {
    // The pre-fix state denied these only by accident: an unmatched tool
    // falls to the `other` class, which defaults to deny. That is not a
    // designed defence and it evaporates the moment an adapter classifies
    // such a name as `command`. Declaring `command` here removes the
    // accidental safety net, so only the real rule can produce the deny.
    const verdict = evaluate(
      IMMUTABLE_RULES,
      'mcp__foo__spawn_worker',
      ctx({ toolClass: 'command' }),
    );
    expect(verdict.ruleId).toBe('deny.subagent_spawn');
  });

  it('does NOT over-match a normal MCP tool that merely belongs to some server', () => {
    for (const tool of ['mcp__foo__read_file', 'mcp__foo__list_spawns', 'mcp__spawn__read']) {
      const verdict = evaluate(IMMUTABLE_RULES, tool, ctx({ toolClass: 'read' }));
      expect(verdict.ruleId, `${tool} must not be caught by deny.subagent_spawn`).not.toBe(
        'deny.subagent_spawn',
      );
    }
  });

  it('the grammar globs the tool-name position, not only the argglob', () => {
    const opts = { pathSemantics: false, caseInsensitive: false };
    expect(matchToolPattern('mcp__*__spawn_*', 'mcp__foo__spawn_worker', '', opts)).toBe(true);
    expect(matchToolPattern('mcp__*__spawn_*', 'mcp__foo__read_file', '', opts)).toBe(false);
    // A `*` inside a tool name must not swallow the `__` separators in a
    // way that makes unrelated names match.
    expect(matchToolPattern('mcp__*__spawn_*', 'notmcp__foo__spawn_x', '', opts)).toBe(false);
  });
});
