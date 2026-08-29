import type { PolicyVariables } from './types';

const VARIABLE_TOKEN = /\$\{(\w+)\}/g;

function lookup(name: string, vars: PolicyVariables): string | null {
  switch (name) {
    case 'worktree':
      return vars.worktree;
    case 'project':
      return vars.project;
    case 'home':
      return vars.home;
    case 'bureau_state':
      return vars.bureau_state;
    default:
      // An unrecognised ${token} is not one of §11.3's four variables —
      // treated the same as unset (matches nothing), never as literal text
      // a rule author might have meant to write out.
      return null;
  }
}

/**
 * §11.3: "An unset variable matches nothing, never everything." The
 * Director has no worktree, so `${worktree}` is `null` for it and every
 * pattern/condition entry referencing it must contribute nothing — the
 * opposite convention (substituting `''`) would silently turn
 * `${worktree}/docs/**` into `/docs/**`, a real, if accidental, absolute
 * path pattern.
 *
 * Returns `null` (never a partially-substituted string) the moment any
 * referenced variable is unset — the caller drops/skips this template
 * rather than matching against a mangled value.
 */
export function expandTemplate(template: string, vars: PolicyVariables): string | null {
  let sawUnset = false;
  const expanded = template.replace(VARIABLE_TOKEN, (_match, name: string) => {
    const value = lookup(name, vars);
    if (value === null) {
      sawUnset = true;
      return '';
    }
    return value;
  });
  return sawUnset ? null : expanded;
}

/**
 * For a list of templates that are ORed together as alternatives — either
 * `path_matches`'s globs (a positive match: any one hit means "matches")
 * or `path_outside`'s roots (a negative match: "outside ALL of these").
 *
 * Both cases drop an unset-variable entry rather than keeping a sentinel:
 * for `path_matches`, dropping an alternative means it simply never
 * contributes to the OR, identical in effect to "never matches" — the
 * correct behaviour either way. For `path_outside`, dropping a root means
 * one fewer thing the path must be outside of, which *tightens* the
 * check, never loosens it (see the Director/`${worktree}` worked example
 * in variables.test.ts) — the safe direction §11.3 requires.
 */
export function expandListDroppingUnset(templates: readonly string[], vars: PolicyVariables): string[] {
  const out: string[] = [];
  for (const template of templates) {
    const expanded = expandTemplate(template, vars);
    if (expanded !== null) out.push(expanded);
  }
  return out;
}
