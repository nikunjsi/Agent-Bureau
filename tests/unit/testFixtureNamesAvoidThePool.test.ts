import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { EMPLOYEE_NAME_POOL } from '../../src/shared/company/nameList';
import { firstNameOf } from '../../src/main/company/allocateName';

/**
 * M11 S1-22: **no test fixture can collide with the name pool by chance.**
 *
 * `allocateName` starts its scan at an offset hashed from the company id,
 * and a test's company id is a fresh ULID, so the name a test's Director
 * (or any hire without a name) draws is effectively random across runs.
 * A test that then hires a FIXED name from the same pool — "Ravi" — is
 * refused (`FirstNameTakenError`, §6.8) or rehires the archived namesake
 * whenever the dice match. The product is right both times; the fixture
 * is nondeterministic. It turned CI red twice in §S1 (the Director drew
 * Ravi in `assembleDirectorContext`, and Nadia in `fireAndRehire`).
 *
 * The mechanism chosen is the one that leaves product code alone: **every
 * fixed name in `tests/` is outside `EMPLOYEE_NAME_POOL`.** The allocator
 * stays exactly as §6.8 wants it, and no test can reach a collision it did
 * not write on purpose. This test is what keeps it that way: any string
 * literal in `tests/` whose first word is a pool first name (case-folded,
 * because that is how §6.8 compares) fails here.
 *
 * It checks every literal, not only the ones passed to a hire, because a
 * fixture's name travels — `seedEmployee`, raw `INSERT` arrays, an
 * adapter context, an e2e assertion on the seeded name — and a pattern for
 * "this literal is a hire" would be the incomplete one.
 */

/** Same stripper as `powerShellSpawnsGoThroughOneHelper.test.ts`. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(full)) out.push(full.split(path.sep).join('/'));
  }
  return out;
}

/** Single-, double- and interpolation-free backtick-quoted literals on one line. */
const STRING_LITERAL = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$\n]*)`/g;

const POOL_FIRST_NAMES = new Set(EMPLOYEE_NAME_POOL.map(firstNameOf));

export function poolNamesIn(source: string): string[] {
  const hits: string[] = [];
  for (const match of stripComments(source).matchAll(STRING_LITERAL)) {
    const literal = match[1] ?? match[2] ?? match[3] ?? '';
    if (POOL_FIRST_NAMES.has(firstNameOf(literal))) hits.push(literal);
  }
  return hits;
}

describe('fixed employee names in tests are outside the name pool', () => {
  it('recognises a pool name in a hire, in any case, and ignores it in a comment', () => {
    expect(poolNamesIn(`hire({ name: 'Ravi' })`)).toEqual(['Ravi']);
    expect(poolNamesIn(`seedEmployee(db, { name: "nadia" })`)).toEqual(['nadia']);
    expect(poolNamesIn('makeEmployee(`Priya Shah`)')).toEqual(['Priya Shah']);
    expect(poolNamesIn(`// the Director drew 'Ravi'\nhire({ name: 'Quinn' })`)).toEqual([]);
  });

  it('no test under tests/ uses a pool first name as a fixed string', () => {
    const offenders: string[] = [];
    // This file names pool members on purpose, to prove the detector sees them.
    const self = 'tests/unit/testFixtureNamesAvoidThePool.test.ts';
    for (const file of walk('tests').filter((f) => f !== self)) {
      const hits = poolNamesIn(readFileSync(file, 'utf8'));
      if (hits.length > 0) offenders.push(`${file}: ${[...new Set(hits)].join(', ')}`);
    }
    expect(
      offenders,
      'A fixed name from EMPLOYEE_NAME_POOL can collide with the name a hire draws at random ' +
        '(the draw is seeded by a fresh company id). Use a name outside the pool, e.g. Quinn.',
    ).toEqual([]);
  });
});
