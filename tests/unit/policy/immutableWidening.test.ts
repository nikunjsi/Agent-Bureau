import { describe, expect, it } from 'vitest';
import {
  assertNoImmutableWidening,
  verifyExemplars,
  CANONICAL_POLICY_VARIABLES,
} from '../../../src/shared/policy/immutableWidening';
import { roleRulesFrom } from '../../../src/shared/policy/ruleLoader';
import { IMMUTABLE_RULES } from '../../../src/shared/policy/immutableRules';
import { evaluate } from '../../../src/shared/policy/evaluator';
import { matchToolPatternWithVariables } from '../../../src/shared/policy/patternGrammar';
import type { PolicyVariables, Rule } from '../../../src/shared/policy/types';

function allowRulesFor(toolsAllow: string[]): Rule[] {
  return roleRulesFrom({ full_key: 'testpack:tester', tools_allow: toolsAllow, tools_deny: [] });
}

describe('verifyExemplars — the anti-vacuity guard (§6.7 check 5)', () => {
  it('every exemplar is really denied by the immutable rule it names', () => {
    // Runs the REAL evaluator, one immutable rule at a time. If §11.3's
    // rules change so an exemplar stops being denied, this throws by name
    // rather than letting check 5 quietly validate against calls nothing
    // forbids any more.
    expect(() => verifyExemplars()).not.toThrow();
  });
});

describe('assertNoImmutableWidening — patterns that DO widen', () => {
  it('rejects an allow aimed at the canonical project checkout (AUDIT #9’s scenario)', () => {
    const errors = assertNoImmutableWidening(allowRulesFor(['Write(${project}/**)']));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('deny.write_outside_worktree');
    expect(errors[0]).toContain('Write(${project}/**)');
  });

  it('rejects an allow aimed at credential paths', () => {
    const errors = assertNoImmutableWidening(allowRulesFor(['Read(${worktree}/.env*)']));
    expect(errors[0]).toContain('deny.credential_paths');
  });

  it('rejects committing, even hidden among legitimate alternatives', () => {
    const errors = assertNoImmutableWidening(
      allowRulesFor(['Bash(npm *|git commit -m *|pytest *)']),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('deny.git_write');
    // Names the offending ALTERNATIVE, not the whole pattern — a pack
    // author reading this needs to know which one to remove.
    expect(errors[0]).toContain('Bash(git commit -m *)');
  });

  it('rejects allowing the sub-agent tool itself, which takes no arguments to restrict', () => {
    expect(assertNoImmutableWidening(allowRulesFor(['Task']))[0]).toContain('deny.subagent_spawn');
    expect(assertNoImmutableWidening(allowRulesFor(['mcp__mypack__spawn_helper']))[0]).toContain(
      'deny.subagent_spawn',
    );
  });

  it('rejects a blanket allow-everything, which reaches the tool-identity denies', () => {
    expect(assertNoImmutableWidening(allowRulesFor(['*']))).not.toHaveLength(0);
  });

  it('rejects reaching into Bureau’s own state directory', () => {
    const errors = assertNoImmutableWidening(allowRulesFor(['Read(**/AppData/Roaming/Bureau/**)']));
    expect(errors[0]).toContain('deny.system_paths');
  });
});

describe('assertNoImmutableWidening — patterns that do NOT widen', () => {
  // The distinction the check turns on. `Read(**)` is how §6.5's own
  // reference role says "this role reads files"; the immutable denies
  // carve their exceptions out of it at evaluation time. Flagging it
  // would make the spec's own example uninstallable.
  it('accepts the full tools_allow list from §6.5’s reference developer role', () => {
    const errors = assertNoImmutableWidening(
      allowRulesFor([
        'Read(**)',
        'Grep(**)',
        'Glob(**)',
        'Write(${worktree}/**)',
        'Edit(${worktree}/**)',
        'Bash(npm *|pnpm *|yarn *|pytest *|python *|node *)',
      ]),
    );
    expect(errors).toEqual([]);
  });

  it('accepts a worktree-scoped write, which cannot reach the project checkout', () => {
    expect(assertNoImmutableWidening(allowRulesFor(['Write(${worktree}/src/**)']))).toEqual([]);
  });

  it('ignores deny rules — only an allow can be a widening', () => {
    const denyOnly = roleRulesFrom({
      full_key: 'testpack:tester',
      tools_allow: [],
      tools_deny: ['Bash(git commit *)', 'Task'],
    });
    expect(assertNoImmutableWidening(denyOnly)).toEqual([]);
  });

  it('ignores the immutable rules themselves', () => {
    // Passing the real immutable array in must not report the rules as
    // widening themselves.
    expect(assertNoImmutableWidening(allowRulesFor([]))).toEqual([]);
  });
});

describe('why the canonical variables are not optional', () => {
  /**
   * The subtlety that decides whether check 5 works at all, demonstrated
   * against the real matcher rather than asserted in a comment:
   * `matchToolPatternWithVariables` DROPS an alternative that references
   * an unset variable. So with variables null — the shape a plain unit
   * test reaches for first — every `${project}` pattern matches nothing
   * and the whole check passes while testing nothing.
   */
  it('an unset-variable context makes a ${project} pattern match nothing at all', () => {
    const UNSET: PolicyVariables = {
      worktree: null,
      project: null,
      home: null,
      bureau_state: null,
    };
    const pathOpts = { pathSemantics: true, caseInsensitive: true };
    const target = `${CANONICAL_POLICY_VARIABLES.project}/src/index.ts`;

    expect(
      matchToolPatternWithVariables('Write(${project}/**)', 'Write', target, UNSET, pathOpts),
    ).toBe(false);
    expect(
      matchToolPatternWithVariables(
        'Write(${project}/**)',
        'Write',
        target,
        CANONICAL_POLICY_VARIABLES,
        pathOpts,
      ),
    ).toBe(true);
  });
});

describe('N-9: deny.git_write covers ordinary push shapes', () => {
  // Each shape is checked against the git_write rule ALONE, so a shape that
  // is only denied incidentally by another rule cannot pass here. The first
  // version of the rule had only `git push *`, which misses a bare `git push`
  // and every `-C`/`--git-dir` form.
  const gitWrite = IMMUTABLE_RULES.find((rule) => rule.id === 'deny.git_write') as Rule;
  const shapes = [
    'git push',
    'git push origin main',
    'git -C . push',
    'git -C ../repo push origin main',
    'git --git-dir=.git push',
    'git --git-dir .git push --force origin main',
  ];

  it.each(shapes)('denies `%s`', (command) => {
    const verdict = evaluate([gitWrite], 'Bash', {
      toolClass: 'command',
      canonicalPath: null,
      canonicalArg: command,
      domain: null,
      variables: CANONICAL_POLICY_VARIABLES,
      effectiveAutonomy: 'autonomous',
      now: new Date('2026-01-01T12:00:00Z'),
      rawArgs: {},
    });
    expect(verdict.effect).toBe('deny');
    expect(verdict.ruleId).toBe('deny.git_write');
  });
});
