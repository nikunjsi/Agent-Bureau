import type { Condition, MatchContext } from './types';
import { compileGlob } from './patternGrammar';
import { expandListDroppingUnset } from './variables';

const PATH_GLOB_OPTS = { pathSemantics: true, caseInsensitive: true } as const;

function isUnderRoot(candidate: string, root: string): boolean {
  // Each root is matched either exactly or as a directory prefix — roots
  // are ordinary paths (`${worktree}`, `${bureau_state}/tmp`), not globs,
  // in every rule this session actually uses, but compiling as a glob
  // costs nothing and lets a future rule use wildcards in a root too.
  return compileGlob(root, PATH_GLOB_OPTS).test(candidate) || compileGlob(`${root}/**`, PATH_GLOB_OPTS).test(candidate);
}

/**
 * §11.3: "Path conditions do not apply to `Bash`." Stated once, here,
 * applied uniformly regardless of which rule carries the condition —
 * `deny.credential_paths`'s own YAML names `Bash(**)` in its
 * `tool_pattern` alongside a `path_matches` condition; that half of the
 * rule is structurally present (matches spec's own text verbatim) but
 * permanently inert, because this check makes any path condition
 * evaluate to "no match" for a command-class call before ever looking at
 * `canonicalPath`. Extracting "the paths a shell command touches" is
 * undecidable in general (`cat $(echo .env)` defeats any parser) — this
 * is an honesty correction per §11.3, not a limitation being introduced,
 * and not something to work around with a command-line path parser.
 */
function pathConditionsApply(ctx: MatchContext): boolean {
  return ctx.toolClass !== 'command';
}

export function matchCondition(condition: Condition, ctx: MatchContext): boolean {
  switch (condition.kind) {
    case 'path_matches': {
      if (!pathConditionsApply(ctx)) return false;
      if (ctx.canonicalPath === null) return false; // nothing to test against
      const globs = expandListDroppingUnset(condition.globs, ctx.variables).map((g) => g.toLowerCase());
      return globs.some((g) => compileGlob(g, PATH_GLOB_OPTS).test(ctx.canonicalPath!));
    }

    case 'path_outside': {
      if (!pathConditionsApply(ctx)) return false;
      // An unresolvable path (canonicalisation failed closed, or the call
      // simply has none) is treated as outside any legitimate root —
      // fail closed, never "nothing to check against so let it through".
      if (ctx.canonicalPath === null) return true;
      const roots = expandListDroppingUnset(condition.roots, ctx.variables).map((r) => r.toLowerCase());
      if (roots.length === 0) return true; // every referenced variable was unset — nothing to be "inside" of
      return !roots.some((root) => isUnderRoot(ctx.canonicalPath!, root));
    }

    case 'domain_matches': {
      if (ctx.domain === null) return false;
      const globs = expandListDroppingUnset(condition.globs, ctx.variables).map((g) => g.toLowerCase());
      return globs.some((g) => compileGlob(g, { pathSemantics: false, caseInsensitive: true }).test(ctx.domain!.toLowerCase()));
    }

    case 'arg_regex': {
      // A malformed pattern (role/pack authoring error) is allowed to
      // throw here — CLAUDE.md invariant #6 names "ambiguous rule" as a
      // fail-closed case explicitly, and what "closed" means depends on
      // the rule's own effect (a thrown error should make a `deny`
      // MATCH, not silently fail to fire — the opposite of what it would
      // mean for an `allow`). That decision needs the rule's effect,
      // which this function doesn't have; evaluator.ts's caller catches
      // this and resolves it per-rule. Not caught and defaulted to
      // `false` here, which would be silently unsafe for a deny rule.
      return new RegExp(condition.pattern, condition.flags ?? '').test(ctx.canonicalArg);
    }

    case 'time_window': {
      const hour = ctx.now.getHours();
      const { startHourLocal: start, endHourLocal: end } = condition;
      if (start === end) return true; // a zero-width window means "always"
      if (start < end) return hour >= start && hour < end;
      return hour >= start || hour < end; // wraps midnight, e.g. 22 -> 6
    }

    // Exhaustive per §11.3's own condition list, but no tool in §23's
    // inventory is a SQL/catalog tool, so there is no real, spec-given arg
    // shape to key off — inventing one now would be exactly the kind of
    // guessing-at-a-format the M7 pack seam deliberately avoids. These
    // read a conventionally-named field defensively rather than crash;
    // genuinely unexercised by any rule this session.
    case 'sql_statement_kind_not_in': {
      const kind = readStringField(ctx.rawArgs, 'statementKind');
      if (kind === null) return false;
      return !condition.kinds.includes(kind);
    }
    case 'catalog_matches': {
      const catalog = readStringField(ctx.rawArgs, 'catalog');
      if (catalog === null) return false;
      return condition.globs.some((g) => compileGlob(g, { pathSemantics: false, caseInsensitive: true }).test(catalog));
    }

    default: {
      const exhaustive: never = condition;
      throw new Error(`unreachable condition kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function readStringField(rawArgs: unknown, field: string): string | null {
  if (typeof rawArgs !== 'object' || rawArgs === null) return null;
  const value = (rawArgs as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}
