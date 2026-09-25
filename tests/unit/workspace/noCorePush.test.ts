import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * §10.6 rule 6, decision E-5: **Bureau itself never pushes in v1.** Delivery
 * is rule 5's local merge; the only push rule 6 governs is one nobody
 * approved, which the detector (`pushDetection.ts`) finds after the fact.
 * This holds the claim at the source: no Core git invocation names `push`.
 * A push feature is future scope, and would start by deleting this test.
 */
const MAIN = path.resolve(__dirname, '..', '..', '..', 'src', 'main');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the Core never pushes to a remote', () => {
  it('no git invocation in the main process names push', () => {
    const offenders = tsFilesUnder(MAIN)
      .filter((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .some((line) => !/^\s*(\/\/|\*)/.test(line) && /['"`]push['"`]/.test(line)),
      )
      .map((file) => path.relative(MAIN, file).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });
});
