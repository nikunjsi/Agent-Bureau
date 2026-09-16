// AUDIT M0–M2 #24 — §5.2's event taxonomy against EVENT_TYPES.
//
// §5.2's list became load-bearing at M9 (audit #25): EVENT_TYPES is a
// closed z.enum, so an undocumented emitter fails typecheck. That closes
// the code side. Nothing checked that the SPEC still agreed with it, so a
// type added to the enum without a §5.2 entry — or documented in §5.2 and
// never added — drifted silently. Session 2 declined an `events.type`
// CHECK partly because §5.2 had no mechanical check; this is that check.
//
// Row grammar, enforced rather than assumed:
//   | `prefix.` | `a`, `b` (aside), plus `c` (aside). Optional prose… |
// Parentheticals are stripped, then the list ends at the first sentence
// break. What remains must be ONLY backticked names separated by commas and
// an optional "plus". Anything else fails — see specLists.mjs for why.
import { importTs, report, specSection, stripParentheticals } from './specLists.mjs';

const ROW = /^\|\s*`([a-z]+)\.`\s*\|(.*)\|\s*$/;
const LIST_ONLY = /^\s*(?:(?:plus\s+)?`[a-z_0-9]+`\s*,?\s*)+$/;

const problems = [];
const specTypes = new Set();
let rows = 0;

for (const line of specSection('### 5.2 Event taxonomy', '### 5.3')) {
  const m = ROW.exec(line);
  if (!m) continue;
  rows += 1;
  const [, prefix, cell] = m;
  const withoutAsides = stripParentheticals(cell);
  const sentenceBreak = withoutAsides.search(/\.\s/);
  const list = sentenceBreak >= 0 ? withoutAsides.slice(0, sentenceBreak) : withoutAsides;
  if (!LIST_ONLY.test(list)) {
    problems.push(
      `  §5.2 row \`${prefix}.\`: the type list could not be read unambiguously ` +
        `("${list.trim().slice(0, 80)}…"). Keep prose inside parentheses or after a full stop.`,
    );
    continue;
  }
  for (const t of list.matchAll(/`([a-z_0-9]+)`/g)) specTypes.add(`${prefix}.${t[1]}`);
}

if (rows === 0) problems.push('  found no §5.2 taxonomy rows at all — the parser is broken');

const { EVENT_TYPES } = await importTs('src/shared/models/eventTypes.ts');
const codeTypes = new Set(EVENT_TYPES);

for (const t of [...specTypes].sort()) {
  if (!codeTypes.has(t)) problems.push(`  ${t}: in §5.2, missing from EVENT_TYPES`);
}
for (const t of [...codeTypes].sort()) {
  if (!specTypes.has(t)) problems.push(`  ${t}: in EVENT_TYPES, missing from §5.2`);
}

report(
  'check:event-taxonomy',
  problems,
  `§5.2 event taxonomy matches EVENT_TYPES: ${codeTypes.size} types across ${rows} prefixes.`,
);
