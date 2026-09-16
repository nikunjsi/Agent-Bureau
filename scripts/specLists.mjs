// Shared helpers for the spec-vs-code list checks (AUDIT M0–M2 #24).
//
// Each check reads one enumerable list out of docs/BUILD-SPEC.md and diffs
// it against the code that is supposed to match it. They are deliberately
// strict parsers: a row whose shape they do not recognise is an ERROR, not
// something to skip or guess at. A spec check that quietly ignores what it
// cannot read is the exact failure these scripts exist to close — the
// Phase 1 audit's own prototypes read session 2's new prose in §5.2 as two
// phantom event types, which is harmless noise in a one-off audit and a
// lie in CI.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

export const rootDir = path.resolve(import.meta.dirname, '..');

export function specSection(startHeading, endPrefix) {
  const lines = readFileSync(path.join(rootDir, 'docs', 'BUILD-SPEC.md'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(startHeading));
  if (start < 0) throw new Error(`BUILD-SPEC.md has no heading starting "${startHeading}"`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith(endPrefix));
  if (end < 0) throw new Error(`BUILD-SPEC.md has no "${endPrefix}" after "${startHeading}"`);
  return lines.slice(start, end);
}

/** Bundles a TypeScript module (and its imports, zod included) and imports
 * the result — so the check reads the REAL registry, not a copy of it. */
export async function importTs(relativePath) {
  const result = await esbuild.build({
    entryPoints: [path.join(rootDir, relativePath)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/** Removes balanced (...) groups, innermost first, so prose asides inside a
 * list cannot be read as list items. */
export function stripParentheticals(text) {
  let current = text;
  let previous;
  do {
    previous = current;
    current = current.replace(/\([^()]*\)/g, '');
  } while (current !== previous);
  return current;
}

export function report(name, problems, successLine) {
  if (problems.length > 0) {
    console.error(`${name}: the spec and the code disagree:\n`);
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(successLine);
}
