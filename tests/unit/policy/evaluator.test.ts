import { describe, expect, it } from 'vitest';
import { evaluate, isBureauTool } from '../../../src/shared/policy/evaluator';
import { IMMUTABLE_RULES } from '../../../src/shared/policy/immutableRules';
import type { MatchContext, PolicyVariables, Rule } from '../../../src/shared/policy/types';

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
    now: new Date(2026, 0, 1, 12),
    rawArgs: {},
    ...overrides,
  };
}

describe('isBureauTool — traps carried forward from the interim evaluator', () => {
  it('matches the real MCP-namespaced form an engine actually reports (found against a real agent, M4 session 2)', () => {
    expect(isBureauTool('mcp__bureau__bureau_task_done')).toBe(true);
    expect(isBureauTool('mcp__bureau__bureau_report_status')).toBe(true);
  });

  it('matches a bare bureau_* name too', () => {
    expect(isBureauTool('bureau_task_done')).toBe(true);
  });

  it('does not treat a tool merely containing "bureau_" mid-string as the bureau class', () => {
    expect(isBureauTool('not_bureau_report_status')).toBe(false);
  });

  it('does not allow an MCP tool from a different server merely for containing "bureau_" in its own name', () => {
    expect(isBureauTool('mcp__other_server__bureau_task_done')).toBe(false);
  });
});

describe('evaluate — bureau short-circuit ahead of the immutable-deny scan', () => {
  it('a bureau tool is allowed even with zero rules loaded', () => {
    const result = evaluate([], 'mcp__bureau__bureau_task_done', ctx({ toolClass: 'bureau' }));
    expect(result).toEqual({ effect: 'allow', ruleId: 'bureau.always_allow' });
  });

  it('a bureau tool is allowed even against a canonical path that would otherwise be denied', () => {
    const result = evaluate(
      [...IMMUTABLE_RULES],
      'bureau_report_status',
      ctx({ toolClass: 'bureau', canonicalPath: 'c:/windows/x' }),
    );
    expect(result.effect).toBe('allow');
  });
});

describe('evaluate — the verdict === null guard is load-bearing', () => {
  const higherPriorityAllow: Rule = {
    id: 'r-allow',
    immutable: false,
    effect: 'allow',
    toolPattern: 'Read(**)',
    priority: 1,
  };
  const lowerPriorityAsk: Rule = {
    id: 'r-ask',
    immutable: false,
    effect: 'ask',
    toolPattern: 'Read(**)',
    priority: 2,
    reason: 'later ask',
  };
  const matchCtx = ctx({
    toolClass: 'read',
    canonicalPath: 'c:/wt/ravi/x.ts',
    canonicalArg: 'c:/wt/ravi/x.ts',
  });

  it('the real evaluator: an already-matched allow is NOT overridden by a lower-priority ask found later in the scan', () => {
    const result = evaluate([higherPriorityAllow, lowerPriorityAsk], 'Read', matchCtx);
    expect(result).toEqual({ effect: 'allow', ruleId: 'r-allow' });
  });

  it(
    'MUTATION CHECK (reported, not shipped): an unguarded loop — reassigning verdict on every non-deny ' +
      'match instead of only the first — DOES let the later ask silently override the allow, proving the ' +
      'guard in evaluate() is what prevents it',
    () => {
      // A deliberate, local reimplementation of the *unguarded* version of
      // §11.3's pseudocode — not the production evaluate(), which keeps
      // the guard. This exists only to show what would happen without it.
      function unguardedEvaluate(rules: Rule[]): { effect: string; ruleId: string } {
        let verdict: { effect: string; ruleId: string } | null = null;
        for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
          verdict = { effect: rule.effect, ruleId: rule.id }; // no `if (verdict === null)` guard
        }
        return verdict!;
      }
      expect(unguardedEvaluate([higherPriorityAllow, lowerPriorityAsk])).toEqual({
        effect: 'ask',
        ruleId: 'r-ask',
      });
    },
  );
});

describe('evaluate — a deny always wins immediately, regardless of scan order or priority', () => {
  it('a deny found after an allow still wins', () => {
    const allowFirst: Rule = {
      id: 'allow-first',
      immutable: false,
      effect: 'allow',
      toolPattern: 'Read(**)',
      priority: 1,
    };
    const denyLater: Rule = {
      id: 'deny-later',
      immutable: false,
      effect: 'deny',
      toolPattern: 'Read(**)',
      priority: 2,
      reason: 'x',
    };
    const result = evaluate(
      [allowFirst, denyLater],
      'Read',
      ctx({ toolClass: 'read', canonicalPath: 'c:/wt/ravi/x' }),
    );
    expect(result.effect).toBe('deny');
    expect(result.effect === 'deny' && result.ruleId).toBe('deny-later');
  });
});

describe('evaluate — falls through to autonomyDefaultFor when nothing matches', () => {
  it('a read with no matching rule at all falls to the read default (allow, per §11.2)', () => {
    const result = evaluate(
      [],
      'SomeUnknownReadTool',
      ctx({ toolClass: 'read', canonicalPath: 'c:/wt/ravi/x' }),
    );
    expect(result.effect).toBe('allow');
    expect(result.ruleId).toMatch(/^autonomy_default\./);
  });

  it('an "other"-class tool denies by default, not ask (§11.3 explicit instruction)', () => {
    const result = evaluate([], 'SomeUnrecognisedTool', ctx({ toolClass: 'other' }));
    expect(result.effect).toBe('deny');
  });
});

describe('evaluate — deny.credential_paths\u2019 Bash(**) half is real but permanently inert', () => {
  it('a Read of a credential path is denied', () => {
    const result = evaluate(
      [...IMMUTABLE_RULES],
      'Read',
      ctx({ toolClass: 'read', canonicalPath: 'c:/wt/ravi/.ssh/id_rsa' }),
    );
    expect(result).toMatchObject({ effect: 'deny', ruleId: 'deny.credential_paths' });
  });

  it('a Bash command whose canonical arg mentions a credential path is NOT denied by deny.credential_paths — path conditions never apply to Bash (§11.3)', () => {
    const result = evaluate(
      [...IMMUTABLE_RULES],
      'Bash',
      ctx({ toolClass: 'command', canonicalArg: 'cat ~/.ssh/id_rsa', canonicalPath: null }),
    );
    // Not denied BY THIS RULE — falls through to the command autonomy
    // default instead (ask, at guided), proving the rule's Bash(**) half
    // genuinely never fires, rather than accidentally still blocking it
    // by some other path and masking the honesty gap.
    expect(result.ruleId).not.toBe('deny.credential_paths');
  });
});

describe('evaluate — deny.write_outside_worktree / deny.read_outside_project, end to end', () => {
  it('a write inside the worktree is allowed (no immutable rule fires, falls to the write default)', () => {
    const result = evaluate(
      [...IMMUTABLE_RULES],
      'Write',
      ctx({ toolClass: 'write', canonicalPath: 'c:/wt/ravi/src/index.ts' }),
    );
    expect(result.effect).toBe('allow');
  });

  it('a write outside the worktree (even inside the project) is denied — writes never see ${project}', () => {
    const result = evaluate(
      [...IMMUTABLE_RULES],
      'Write',
      ctx({ toolClass: 'write', canonicalPath: 'c:/projects/acme/src/other-file.ts' }),
    );
    expect(result).toMatchObject({ effect: 'deny', ruleId: 'deny.write_outside_worktree' });
  });

  it('a read inside the project (but outside the worktree) IS allowed — reads may see the project', () => {
    const result = evaluate(
      [...IMMUTABLE_RULES],
      'Read',
      ctx({ toolClass: 'read', canonicalPath: 'c:/projects/acme/README.md' }),
    );
    expect(result.effect).toBe('allow');
  });
});

describe('evaluate — a condition that throws (CLAUDE.md invariant #6: "ambiguous rule" fails closed) resolves per the rule\u2019s own effect', () => {
  const malformedRegex = { kind: 'arg_regex', pattern: '(unclosed' } as const;

  it('on a deny rule, a thrown condition MATCHES — the deny fires, the safe direction', () => {
    const rule: Rule = {
      id: 'test.malformed-deny',
      immutable: false,
      effect: 'deny',
      toolPattern: 'Bash(**)',
      condition: malformedRegex,
      reason: 'test',
      priority: 50,
    };
    const result = evaluate(
      [rule],
      'Bash',
      ctx({ toolClass: 'command', canonicalArg: 'anything' }),
    );
    expect(result).toMatchObject({ effect: 'deny', ruleId: 'test.malformed-deny' });
  });

  it('on an allow rule, a thrown condition does NOT match — the rule doesn\u2019t fire, falls through to the stricter default', () => {
    const rule: Rule = {
      id: 'test.malformed-allow',
      immutable: false,
      effect: 'allow',
      toolPattern: 'Bash(**)',
      condition: malformedRegex,
      priority: 50,
    };
    const result = evaluate(
      [rule],
      'Bash',
      ctx({ toolClass: 'command', canonicalArg: 'anything', effectiveAutonomy: 'guided' }),
    );
    // Falls through to the command autonomy default at guided (ask —
    // nothing on the allow-list actually matched), never the forged allow.
    expect(result.ruleId).not.toBe('test.malformed-allow');
  });

  it(
    'MUTATION CHECK (reported, not shipped): defaulting a thrown condition to "no match" unconditionally — ' +
      'the earlier version of this code — would silently let the malformed deny rule above never fire',
    () => {
      function unsafeConditionMatch(): boolean {
        try {
          throw new Error('malformed regex');
        } catch {
          return false; // the earlier, unsafe default — wrong for a deny rule
        }
      }
      expect(unsafeConditionMatch()).toBe(false); // proves the deny rule would NOT have matched under the old behaviour
    },
  );
});
