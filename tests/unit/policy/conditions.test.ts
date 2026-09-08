import { describe, expect, it } from 'vitest';
import { matchCondition } from '../../../src/shared/policy/conditions';
import type { Condition, MatchContext, PolicyVariables } from '../../../src/shared/policy/types';

const VARS: PolicyVariables = {
  worktree: 'c:/wt/ravi',
  project: 'c:/projects/acme',
  home: 'c:/users/nikunj/bureau',
  bureau_state: 'c:/state/emp1',
};

function ctx(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    toolClass: 'read',
    canonicalPath: null,
    canonicalArg: '',
    domain: null,
    variables: VARS,
    effectiveAutonomy: 'guided',
    now: new Date(2026, 0, 1, 12, 0, 0),
    rawArgs: {},
    ...overrides,
  };
}

describe('matchCondition — path_matches', () => {
  const condition: Condition = { kind: 'path_matches', globs: ['**/.ssh/**', '**/*.pem'] };

  it('matches a credential-shaped path', () => {
    expect(matchCondition(condition, ctx({ canonicalPath: 'c:/wt/ravi/.ssh/id_rsa' }))).toBe(true);
    expect(matchCondition(condition, ctx({ canonicalPath: 'c:/wt/ravi/secrets/key.pem' }))).toBe(
      true,
    );
  });

  it('does not match an ordinary path', () => {
    expect(matchCondition(condition, ctx({ canonicalPath: 'c:/wt/ravi/src/index.ts' }))).toBe(
      false,
    );
  });

  it('never applies to a command-class call — the Bash honesty correction, §11.3', () => {
    expect(
      matchCondition(
        condition,
        ctx({ toolClass: 'command', canonicalPath: 'c:/wt/ravi/.ssh/id_rsa' }),
      ),
    ).toBe(false);
  });

  it('with no canonical path at all, does not match (nothing to test)', () => {
    expect(matchCondition(condition, ctx({ canonicalPath: null }))).toBe(false);
  });
});

describe('matchCondition — path_outside', () => {
  const condition: Condition = {
    kind: 'path_outside',
    roots: ['${worktree}', '${bureau_state}/tmp'],
  };

  it('a path inside the worktree is not "outside"', () => {
    expect(matchCondition(condition, ctx({ canonicalPath: 'c:/wt/ravi/src/index.ts' }))).toBe(
      false,
    );
  });

  it('a path inside the bureau_state/tmp scratch root is not "outside"', () => {
    expect(matchCondition(condition, ctx({ canonicalPath: 'c:/state/emp1/tmp/scratch.txt' }))).toBe(
      false,
    );
  });

  it('a path outside every root is "outside"', () => {
    expect(matchCondition(condition, ctx({ canonicalPath: 'c:/projects/acme/src/index.ts' }))).toBe(
      true,
    );
  });

  it('an unresolvable path (canonicalisation failed closed to null) is treated as outside — fail closed', () => {
    expect(matchCondition(condition, ctx({ canonicalPath: null }))).toBe(true);
  });

  it('never applies to a command-class call', () => {
    expect(
      matchCondition(condition, ctx({ toolClass: 'command', canonicalPath: 'c:/projects/acme/x' })),
    ).toBe(false);
  });

  it('the Director worked example: ${worktree} unset degrades to one root, tightening the check', () => {
    const director = ctx({
      variables: {
        worktree: null,
        project: null,
        home: VARS.home,
        bureau_state: 'c:/state/director',
      },
      canonicalPath: 'c:/anywhere/at/all.txt',
    });
    expect(matchCondition(condition, director)).toBe(true); // outside the one remaining root -> denied
    const insideDirectorTmp = ctx({
      variables: {
        worktree: null,
        project: null,
        home: VARS.home,
        bureau_state: 'c:/state/director',
      },
      canonicalPath: 'c:/state/director/tmp/scratch.txt',
    });
    expect(matchCondition(condition, insideDirectorTmp)).toBe(false); // inside its own scratch space is fine
  });
});

describe('matchCondition — domain_matches', () => {
  const condition: Condition = {
    kind: 'domain_matches',
    globs: ['docs.python.org', '*.github.com'],
  };

  it('matches an exact allow-listed domain', () => {
    expect(
      matchCondition(condition, ctx({ toolClass: 'network', domain: 'docs.python.org' })),
    ).toBe(true);
  });

  it('matches a subdomain glob', () => {
    expect(matchCondition(condition, ctx({ toolClass: 'network', domain: 'api.github.com' }))).toBe(
      true,
    );
  });

  it('does not match an unlisted domain', () => {
    expect(
      matchCondition(condition, ctx({ toolClass: 'network', domain: 'evil.example.com' })),
    ).toBe(false);
  });

  it('no domain extracted at all does not match', () => {
    expect(matchCondition(condition, ctx({ toolClass: 'network', domain: null }))).toBe(false);
  });

  it('M6 session 2: never applies outside a network-class call, mirroring the Bash gate on path conditions', () => {
    // Same domain, same globs — only toolClass differs. Would match if
    // the gate were missing (ctx().domain is only set explicitly here to
    // prove the gate, not the null-domain default, is what's stopping it).
    expect(matchCondition(condition, ctx({ toolClass: 'read', domain: 'docs.python.org' }))).toBe(
      false,
    );
    expect(
      matchCondition(condition, ctx({ toolClass: 'command', domain: 'docs.python.org' })),
    ).toBe(false);
  });

  describe('negate — role.network_allow synthesized as a deny (ruleLoader.ts’s networkDenyRuleFor)', () => {
    const negated: Condition = { kind: 'domain_matches', globs: ['docs.python.org'], negate: true };

    it('an on-list domain does NOT match the negated condition', () => {
      expect(
        matchCondition(negated, ctx({ toolClass: 'network', domain: 'docs.python.org' })),
      ).toBe(false);
    });

    it('an off-list domain DOES match the negated condition', () => {
      expect(
        matchCondition(negated, ctx({ toolClass: 'network', domain: 'evil.example.com' })),
      ).toBe(true);
    });

    /**
     * REVERSED by AUDIT #12. This previously asserted the opposite —
     * "negation never turns 'nothing to test' into a match" — on grounds
     * of logical symmetry. The symmetry is real but the outcome was
     * fail-OPEN: `WebSearch` is a network tool carrying a query rather
     * than a `url`, so its domain is always null, the synthesized
     * `network_allow` deny never fired, and evaluation fell through to
     * `autonomyDefaultFor('network')` — which allows at `guided` (the
     * shipped default) and `autonomous`. A role declaring
     * `network_allow: []` still got WebSearch.
     *
     * A negated `domain_matches` means "deny unless the destination is on
     * this list". A destination that cannot be read is not on the list.
     * CLAUDE.md invariant #6 names an ambiguous rule as a fail-closed
     * case, and denying is never the unsafe direction.
     */
    it('a null domain DOES match the negated condition — an unverifiable destination is not on the allow-list', () => {
      expect(matchCondition(negated, ctx({ toolClass: 'network', domain: null }))).toBe(true);
    });

    it('but a POSITIVE domain_matches stays inert on a null domain — nothing to test is still not a match', () => {
      const positive: Condition = { kind: 'domain_matches', globs: ['evil.example.com'] };
      expect(matchCondition(positive, ctx({ toolClass: 'network', domain: null }))).toBe(false);
    });

    it('a non-network call still never matches, even negated — the toolClass gate applies before negation', () => {
      expect(matchCondition(negated, ctx({ toolClass: 'read', domain: 'evil.example.com' }))).toBe(
        false,
      );
    });
  });
});

describe('matchCondition — arg_regex', () => {
  it('matches against the canonical argument string', () => {
    const condition: Condition = { kind: 'arg_regex', pattern: '^git push' };
    expect(
      matchCondition(
        condition,
        ctx({ toolClass: 'command', canonicalArg: 'git push origin main' }),
      ),
    ).toBe(true);
    expect(
      matchCondition(condition, ctx({ toolClass: 'command', canonicalArg: 'git status' })),
    ).toBe(false);
  });

  it('a malformed regex throws — deliberately, so the caller (evaluator.ts) can resolve it per the rule’s own effect, not a hardcoded default here', () => {
    // See evaluator.ts's conditionMatchesFailClosed: whether a thrown
    // condition should count as "matched" depends on whether the rule
    // carrying it is a deny (should match — the safe direction) or an
    // allow/ask (should not) — a decision this low-level function can't
    // make on its own, since it never sees the rule's effect.
    const condition: Condition = { kind: 'arg_regex', pattern: '(unclosed' };
    expect(() => matchCondition(condition, ctx({ canonicalArg: 'anything' }))).toThrow();
  });
});

describe('matchCondition — time_window', () => {
  it('matches inside a same-day window', () => {
    const condition: Condition = { kind: 'time_window', startHourLocal: 9, endHourLocal: 17 };
    expect(matchCondition(condition, ctx({ now: new Date(2026, 0, 1, 12) }))).toBe(true);
    expect(matchCondition(condition, ctx({ now: new Date(2026, 0, 1, 20) }))).toBe(false);
  });

  it('a window that wraps midnight matches correctly', () => {
    const condition: Condition = { kind: 'time_window', startHourLocal: 22, endHourLocal: 6 };
    expect(matchCondition(condition, ctx({ now: new Date(2026, 0, 1, 23) }))).toBe(true);
    expect(matchCondition(condition, ctx({ now: new Date(2026, 0, 1, 3) }))).toBe(true);
    expect(matchCondition(condition, ctx({ now: new Date(2026, 0, 1, 12) }))).toBe(false);
  });
});

// §11.3's condition list is exhaustive, but no §23 tool has a stable
// SQL/catalog-shaped arg — these two are type-complete and defensively
// implemented, genuinely unexercised by any real rule this session.
// Covered here only to prove they don't crash and behave sensibly against
// a conventionally-shaped fixture, not because a real rule uses them.
describe('matchCondition — sql_statement_kind_not_in / catalog_matches (unexercised by any real rule)', () => {
  it('sql_statement_kind_not_in reads a conventional field defensively', () => {
    const condition: Condition = { kind: 'sql_statement_kind_not_in', kinds: ['SELECT'] };
    expect(matchCondition(condition, ctx({ rawArgs: { statementKind: 'DELETE' } }))).toBe(true);
    expect(matchCondition(condition, ctx({ rawArgs: { statementKind: 'SELECT' } }))).toBe(false);
    expect(matchCondition(condition, ctx({ rawArgs: {} }))).toBe(false);
  });

  it('catalog_matches reads a conventional field defensively', () => {
    const condition: Condition = { kind: 'catalog_matches', globs: ['prod_*'] };
    expect(matchCondition(condition, ctx({ rawArgs: { catalog: 'prod_orders' } }))).toBe(true);
    expect(matchCondition(condition, ctx({ rawArgs: { catalog: 'staging' } }))).toBe(false);
  });
});
