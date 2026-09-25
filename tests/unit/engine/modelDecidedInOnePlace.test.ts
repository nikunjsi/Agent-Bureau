import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * §7.5 and standing rule 6: **the model an employee runs on is decided in one
 * place, `Supervisor.assign()`.** A second resolution site is how the M7→M4
 * boundary bug happened (hiring decided a model too, and the two disagreed).
 * M11 S3-1's `composeEmployeeContext` must not become one, so this lists every
 * call of `resolveModelTier` in `src/` and fails on a new one.
 */
const SRC = path.resolve(__dirname, '..', '..', '..', 'src');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Calls, not mentions: comment lines are skipped, and the definition is
 *  not a call. */
function callSites(): string[] {
  const sites: string[] = [];
  for (const file of tsFilesUnder(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      if (/\bresolveModelTier\(/.test(code) && !/function resolveModelTier\(/.test(code)) {
        sites.push(path.relative(SRC, file).replace(/\\/g, '/'));
      }
    });
  }
  return sites.sort();
}

describe('the model is decided in one place', () => {
  it('resolveModelTier is called only where a model is actually decided, or only previewed', () => {
    expect(callSites()).toEqual([
      'main/ai/oneshotConfig.ts', // one-shot calls (intent, summaries), not an employee
      'main/company/hireEmployee.ts', // a preview for the hire's cost line; nothing is stored
      'main/engine/supervisor.ts', // assign(): the one decision for a running employee
    ]);
  });
});
