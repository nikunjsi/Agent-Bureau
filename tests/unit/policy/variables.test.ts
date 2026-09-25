import { describe, expect, it } from 'vitest';
import { expandListDroppingUnset, expandTemplate } from '../../../src/shared/policy/variables';
import type { PolicyVariables } from '../../../src/shared/policy/types';

const FULL: PolicyVariables = {
  worktree: 'c:/wt/quinn',
  project: 'c:/projects/acme',
  home: 'c:/users/nikunj/bureau',
  bureau_state: 'c:/state/emp1',
};

describe('expandTemplate', () => {
  it('substitutes every known variable', () => {
    expect(expandTemplate('${worktree}/docs', FULL)).toBe('c:/wt/quinn/docs');
    expect(expandTemplate('${project}', FULL)).toBe('c:/projects/acme');
    expect(expandTemplate('${home}/x', FULL)).toBe('c:/users/nikunj/bureau/x');
    expect(expandTemplate('${bureau_state}/tmp', FULL)).toBe('c:/state/emp1/tmp');
  });

  it('§11.3: an unset variable returns null, never a partially-substituted string', () => {
    const noWorktree: PolicyVariables = { ...FULL, worktree: null };
    expect(expandTemplate('${worktree}/docs/**', noWorktree)).toBeNull();
  });

  it('an unrecognised ${token} is treated as unset, not as literal text', () => {
    expect(expandTemplate('${not_a_real_variable}/x', FULL)).toBeNull();
  });

  it('a template with no variables at all passes through unchanged', () => {
    expect(expandTemplate('C:/Windows/**', FULL)).toBe('C:/Windows/**');
  });
});

describe('expandListDroppingUnset', () => {
  it('drops entries whose variable is unset, keeps the rest', () => {
    const noWorktree: PolicyVariables = { ...FULL, worktree: null };
    expect(expandListDroppingUnset(['${worktree}', '${bureau_state}/tmp'], noWorktree)).toEqual([
      'c:/state/emp1/tmp',
    ]);
  });

  it(
    'the Director worked example: with ${worktree} unset, deny.write_outside_worktree\u2019s root list ' +
      'degrades to one valid root — tightening the check, never loosening it',
    () => {
      const director: PolicyVariables = {
        worktree: null,
        project: null,
        home: FULL.home,
        bureau_state: 'c:/state/director',
      };
      const roots = expandListDroppingUnset(['${worktree}', '${bureau_state}/tmp'], director);
      expect(roots).toEqual(['c:/state/director/tmp']);
      // Any write the Director attempts outside that one remaining root is
      // now "outside all provided roots" by construction — exactly what
      // §11.3 requires (deny), never "no roots to check, so let it through".
      expect(roots.length).toBeGreaterThan(0);
    },
  );

  it('every variable unset -> an empty list (the caller, conditions.ts\u2019s path_outside, treats this as "outside everything")', () => {
    const noneSet: PolicyVariables = {
      worktree: null,
      project: null,
      home: null,
      bureau_state: null,
    };
    expect(expandListDroppingUnset(['${worktree}', '${project}'], noneSet)).toEqual([]);
  });
});
