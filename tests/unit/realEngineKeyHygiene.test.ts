import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Nothing in the test tree reads or sets the parent's `ANTHROPIC_API_KEY`
 * (M11 row S1-6, decision E-2).
 *
 * The engine CLI prefers an environment key over a subscription sign-in. A
 * test that read one would invite exporting it in the shell, which would
 * quietly move the developer's own Claude Code sessions onto a prepaid key.
 * Real-engine tests get their key from a protected file through the secret
 * store and broker (`tests/helpers/realEngineKey.ts`). The helper's
 * refusal reads it from an injectable `env`, never `process.env` directly,
 * so the rule here is absolute. Spawn-environment objects that contain the
 * name (`{ ANTHROPIC_API_KEY: … }`) are not the parent's environment, and
 * are not matched.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

const PARENT_ENV_ACCESS = /process\.env\s*(?:\.\s*ANTHROPIC_API_KEY|\[\s*['"`]ANTHROPIC_API_KEY)/;
const SHELL_ASSIGNMENT = /\bANTHROPIC_API_KEY\s*=\s*\S/;

describe("no test reads or sets the parent's ANTHROPIC_API_KEY", () => {
  it('nothing under tests/ touches process.env.ANTHROPIC_API_KEY', () => {
    // This file's own samples (below) are the one legitimate match.
    const offenders = filesUnder(path.join(REPO_ROOT, 'tests'))
      .filter((file) => path.resolve(file) !== path.resolve(__filename))
      .filter((file) => PARENT_ENV_ACCESS.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it('no npm script or CI step exports it', () => {
    const pkg = readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    const ci = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(SHELL_ASSIGNMENT.test(pkg)).toBe(false);
    expect(/ANTHROPIC_API_KEY\s*:/.test(ci) || SHELL_ASSIGNMENT.test(ci)).toBe(false);
  });

  it('the patterns are not vacuous', () => {
    expect(PARENT_ENV_ACCESS.test("if (process.env['ANTHROPIC_API_KEY']) {}")).toBe(true);
    expect(PARENT_ENV_ACCESS.test('process.env.ANTHROPIC_API_KEY = x')).toBe(true);
    expect(PARENT_ENV_ACCESS.test('expect(spec.env.ANTHROPIC_API_KEY)')).toBe(false);
    expect(SHELL_ASSIGNMENT.test('"x": "ANTHROPIC_API_KEY=abc vitest"')).toBe(true);
  });
});
