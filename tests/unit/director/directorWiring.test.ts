import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The production half of M11 row S1-8, checked at the source because
 * `main()` only runs inside Electron. `startDirector.test.ts` proves what
 * `startDirector` does; this proves the shipped app calls it, and builds
 * every engine adapter that spawns work the one way that carries the
 * user's settings (pre-M11 §F, S-1).
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

describe("the shipped app starts the Director, on the settings' adapter", () => {
  it('main() calls startDirector, without swapping its adapter', () => {
    const main = readFileSync(path.join(SRC, 'main', 'index.ts'), 'utf8');
    const call = /startDirector\(\{[\s\S]*?\}\)/.exec(main)?.[0];

    expect(call).toBeDefined();
    // The test seam must not be used in production: without it,
    // startDirector builds through createClaudeCodeAdapterFromSettings.
    expect(call).not.toMatch(/createAdapter/);
  });

  it('a bare ClaudeCodeAdapter is built only by the two probe sites and the factory itself', () => {
    const sites = tsFilesUnder(SRC)
      .filter((file) => /new ClaudeCodeAdapter\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).replace(/\\/g, '/'))
      .sort();

    expect(sites).toEqual([
      'main/cost/zeroCostMode.ts', // probe only: can zero-cost mode be enabled
      'main/engine/claudeCodeAdapter.ts', // the factory, createClaudeCodeAdapterFromSettings
      'main/index.ts', // probe only: each pack's required engines (§6.3)
    ]);
  });
});
