import type { PatternTerm, PolicyVariables } from './types';
import { expandTemplate } from './variables';

/**
 * §11.3's pattern grammar, defined once, normatively:
 *
 *   pattern := term ("|" term)*
 *   term    := TOOL "(" argglob ")" | TOOL
 *   argglob := glob over the tool's canonical argument string
 *              "*" within a path segment, "**" across segments, "|" for alternation
 *
 * No glob-matching dependency exists in package.json today (checked) — this
 * is hand-written rather than pulling one in for a handful of small,
 * fully-specified rules.
 */

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * Compiles one glob (no `|` alternation left in it — that's split out by
 * the caller) into an anchored RegExp.
 *
 * `pathSemantics: true` (file-tool canonical args, and every path
 * condition): `*` matches within one `/`-delimited segment, `**` matches
 * across segments — exactly the spec's own wording.
 *
 * `pathSemantics: false` (Bash's whitespace-normalised command line, MCP's
 * canonical JSON): there is no "path segment" concept in a command line or
 * a JSON blob, so both `*` and `**` compile to "matches anything". This is
 * a real judgment call, not spelled out verbatim in the spec — the
 * alternative (segment-bound `*` even for Bash) would make a rule like
 * `Bash(git commit *)` fail to match a commit message containing a `/`,
 * which is wrong.
 */
export function compileGlob(glob: string, options: { pathSemantics: boolean; caseInsensitive: boolean }): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1; // consume the second '*'
      } else {
        source += options.pathSemantics ? '[^/]*' : '.*';
      }
      continue;
    }
    source += ch === undefined ? '' : ch.replace(REGEX_SPECIAL, '\\$&');
  }
  return new RegExp(`^${source}$`, options.caseInsensitive ? 'i' : '');
}

/** One glob, or several separated by `|` (the argglob's own internal
 * alternation, distinct from the top-level term alternation) — true if
 * `candidate` matches any alternative. */
export function globMatch(
  globOrAlternatives: string,
  candidate: string,
  options: { pathSemantics: boolean; caseInsensitive: boolean },
): boolean {
  return splitTopLevel(globOrAlternatives, '|').some((alt) => compileGlob(alt, options).test(candidate));
}

/** Splits on `separator` only at paren-depth 0 — needed because a term's
 * own `(...)` can itself contain the separator (e.g. `Bash(a|b|c)` has one
 * top-level term, not three), while a bare argglob's internal `|`
 * alternation (already inside the parens) has no further nesting to worry
 * about, so splitTopLevel degrades to a plain split there. */
export function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** §11.3's own YAML omits `tool_pattern` entirely on `deny.system_paths` —
 * read as "applies regardless of tool" (a condition-only rule), not as a
 * spec gap. Modelled explicitly as this one reserved tool-name token
 * rather than leaving `toolPattern` optional on `Rule`, so every rule
 * still has one uniform field to log/serialise. */
export const WILDCARD_TOOL_PATTERN = '*';

/**
 * Matches a term's TOOL-NAME half (AUDIT #5).
 *
 * The name half used to be a bare `!==` string compare, so a pattern like
 * §11.3's own `deny.subagent_spawn` term `mcp__*__spawn_*` compared its
 * asterisks literally and could never match a real tool. Globs are
 * grammar in this position too — §11.3 writes one into an immutable rule
 * — so a name containing `*` is compiled, and everything else keeps the
 * exact compare it had.
 *
 * Always case-SENSITIVE and never path-segmented, regardless of the
 * tool's class: `"read"` is not `"Read"` (a proven trap carried forward
 * from the interim evaluator), and a tool name has no `/` segments for
 * `**` to mean anything against. The caller's own options govern the
 * argglob only.
 */
export function matchToolName(patternTool: string, tool: string): boolean {
  if (patternTool === WILDCARD_TOOL_PATTERN) return true;
  if (!patternTool.includes('*')) return patternTool === tool;
  return compileGlob(patternTool, { pathSemantics: false, caseInsensitive: false }).test(tool);
}

const TERM_SHAPE = /^([^()]+)\((.*)\)$/s;

/** `pattern := term ("|" term)*` — splits on top-level `|` first, so a
 * term's own argglob alternation is never mistaken for a second term. */
export function parseToolPattern(pattern: string): PatternTerm[] {
  return splitTopLevel(pattern, '|').map((rawTerm) => {
    const trimmed = rawTerm.trim();
    const match = TERM_SHAPE.exec(trimmed);
    if (!match) return { tool: trimmed, argGlob: null };
    return { tool: match[1]!.trim(), argGlob: match[2]! };
  });
}

/**
 * True if `tool` (case-sensitive — proven trap carried forward from the
 * interim evaluator: `"read"` is not `"Read"`) matches any term, AND, for
 * terms that carry an argglob, `canonicalArg` matches it.
 */
export function matchToolPattern(
  pattern: string,
  tool: string,
  canonicalArg: string,
  options: { pathSemantics: boolean; caseInsensitive: boolean },
): boolean {
  return parseToolPattern(pattern).some((term) => {
    if (!matchToolName(term.tool, tool)) return false;
    if (term.argGlob === null) return true;
    return globMatch(term.argGlob, canonicalArg, options);
  });
}

/**
 * Same as `matchToolPattern`, but expands `${worktree}`/`${project}`/
 * `${home}`/`${bureau_state}` in the argglob first, per-alternative — an
 * alternative referencing an unset variable is dropped (never matches),
 * not substituted with `''`. Used for role/pack-supplied patterns, which
 * (per §23.3's own example, `Write(${worktree}/docs/**)`) may reference
 * variables directly in the tool pattern, not only in conditions.
 */
export function matchToolPatternWithVariables(
  pattern: string,
  tool: string,
  canonicalArg: string,
  vars: PolicyVariables,
  options: { pathSemantics: boolean; caseInsensitive: boolean },
): boolean {
  return parseToolPattern(pattern).some((term) => {
    if (!matchToolName(term.tool, tool)) return false;
    if (term.argGlob === null) return true;
    return splitTopLevel(term.argGlob, '|').some((alt) => {
      const expanded = expandTemplate(alt, vars);
      if (expanded === null) return false;
      return compileGlob(expanded, options).test(canonicalArg);
    });
  });
}
