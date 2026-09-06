import { parseToolPattern, splitTopLevel, WILDCARD_TOOL_PATTERN } from './patternGrammar';

/**
 * §6.7 check 4 — "`tools_allow`/`tools_deny` patterns parse against the grammar
 * in §11.3."
 *
 * This exists because **`parseToolPattern` never throws.** An unmatched shape
 * degrades to `{ tool: <the whole string>, argGlob: null }`, which is the right
 * behaviour for the evaluator (a malformed pattern simply matches no real tool
 * name, and matching nothing is the safe direction) but useless as validation:
 * `Bash(rm *` with its paren left open would "parse" into a tool literally
 * named `Bash(rm *`, silently match nothing, and the pack author would never
 * learn their deny rule does nothing.
 *
 * So check 4 needs well-formedness rules of its own, and they live here beside
 * the grammar they describe rather than inside the pack loader.
 */

/** Returns readable errors, one per problem. Empty means the pattern is well-formed. */
export function validateToolPatternSyntax(pattern: string): string[] {
  const errors: string[] = [];
  const trimmed = pattern.trim();

  if (trimmed.length === 0) {
    return ['pattern is empty'];
  }

  // Balance first: an unbalanced paren makes every downstream reading of the
  // pattern meaningless, so report only that.
  let depth = 0;
  for (const ch of trimmed) {
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) break;
    }
  }
  if (depth !== 0) {
    return [`unbalanced parentheses in "${pattern}"`];
  }

  const terms = splitTopLevel(trimmed, '|');
  for (const rawTerm of terms) {
    const term = rawTerm.trim();
    if (term.length === 0) {
      errors.push(`empty term in "${pattern}" (a stray or doubled "|")`);
      continue;
    }
    // Reuse the real parser on the single term so this cannot drift from it.
    const parsed = parseToolPattern(term)[0];
    if (!parsed) {
      errors.push(`term "${term}" in "${pattern}" does not parse`);
      continue;
    }
    // A term the parser could not shape into `TOOL(argglob)` degrades to a
    // tool name holding the whole string, parens and all. That is the
    // signature of every malformed term that got past the balance check —
    // `(**)` with no tool name, `Bash rm *)`, `A(b)c`.
    if (parsed.tool !== WILDCARD_TOOL_PATTERN && /[()]/.test(parsed.tool)) {
      errors.push(`term "${term}" in "${pattern}" is not TOOL or TOOL(argglob)`);
      continue;
    }
    // `Tool()` — an argglob that is present but empty matches only the empty
    // canonical argument, which is almost certainly not what was meant.
    if (parsed.argGlob !== null && parsed.argGlob.trim().length === 0) {
      errors.push(`term "${term}" in "${pattern}" has empty parentheses — use "${parsed.tool}" for any argument`);
    }
  }

  return errors;
}
