import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * §11.7's fifteen security tests are release-blocking, and `npm run
 * test:security` is a **hardcoded list of file paths** in `package.json`,
 * not a glob. That is a deliberate choice (see below), and it has one
 * failure mode: moving or renaming an S-numbered test leaves the suite
 * green while verifying one fewer thing than it reports. That happened in
 * the shape of a near-miss during M7 — S3 moved from
 * `tests/unit/policy/ruleLoader.test.ts` to
 * `tests/integration/packs/s3PackWidening.test.ts`, and nothing but a
 * reviewer's memory would have caught the list not moving with it.
 *
 * **Why not just make it a glob.** A `*.security.test.ts` filename glob
 * silently *includes*; the property actually wanted is that omission
 * loudly *rejects*. And S10 makes a glob wrong on its own terms: it lives
 * as 2-of-8 tests in `claudeCodeAdapterBuildLaunchSpec.test.ts` and
 * 1-of-7 in `genericPtyAdapter.test.ts`, both ~85% ordinary adapter tests.
 * A glob either excludes them — reintroducing the exact silent-drop bug —
 * or forces a `.security.` label onto two files whose names would then
 * lie. Splitting S10 into two new files would be inventing a seam to
 * satisfy a naming rule.
 *
 * So instead: this test reads the REAL `package.json` and the REAL test
 * files, and fails by name when they disagree. Its assertion path touches
 * production configuration, not a copy of it.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TESTS_ROOT = path.join(REPO_ROOT, 'tests');

/** §11.7's own table, verbatim. */
const SECURITY_TESTS: Readonly<Record<number, string>> = {
  1: 'denied_tool_does_not_execute',
  2: 'cannot_escape_workspace',
  3: 'immutable_rule_cannot_be_widened',
  4: 'canary_secret_never_leaks',
  5: 'redaction_across_chunk_boundary',
  6: 'agent_cannot_commit',
  7: 'budget_stops_runaway',
  8: 'breaker_trips_on_loop',
  9: 'worktree_isolation',
  10: 'no_ambient_env',
  11: 'hook_failure_denies',
  12: 'checkpoint_timeout_is_safe',
  13: 'renderer_has_no_node',
  14: 'ipc_rejects_bad_payload',
  15: 'prompt_injection_contained',
};

/**
 * Not yet written, with the milestone that owns each. Shrinking this set
 * is the only correct way to change it — an S-number added here to make
 * this test pass is a lie the next reader inherits.
 */
const NOT_YET_WRITTEN: Readonly<Record<number, string>> = {
  12: 'M8 — checkpoints do not exist yet, so there is no timeout to test',
  15: 'M8 — needs a real end-to-end project run to inject into',
};

/**
 * S13 and S14 are Playwright specs against a real packaged app. They are
 * covered by `npm run test:e2e`, a different runner, and `test:security`
 * (a vitest invocation) cannot run them. Recorded as e2e-covered rather
 * than pretending otherwise.
 */
const E2E_COVERED = new Set([13, 14]);

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      out.push(...listTestFiles(absolute));
    } else if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) {
      out.push(absolute);
    }
  }
  return out;
}

/**
 * Strips block comments and whole-line `//` comments before scanning, so a
 * prose reference in a comment ("the same discipline S1/S2 used") is not
 * mistaken for a test that covers S1. Deliberately does NOT strip trailing
 * `//` comments — that would need string-literal awareness, and a title
 * containing `//` (a URL) would be truncated. The cost of that choice is a
 * missed S-number in a trailing comment, which is the harmless direction.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function securityNumbersIn(source: string): Set<number> {
  const found = new Set<number>();
  for (const match of stripComments(source).matchAll(/\bS(\d{1,2})\b/g)) {
    const n = Number.parseInt(match[1]!, 10);
    if (n >= 1 && n <= 15) found.add(n);
  }
  return found;
}

function securityScript(): string {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts['test:security'];
  if (!script) throw new Error('package.json has no test:security script');
  return script;
}

function listedPaths(): string[] {
  return securityScript()
    .split(/\s+/)
    .filter((token) => token.startsWith('tests/') && token.endsWith('.ts'));
}

/** S-number → the test files that actually claim it. */
function coverageMap(): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const absolute of listTestFiles(TESTS_ROOT)) {
    const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
    // This file talks about every S-number by definition.
    if (relative.endsWith('securitySuiteCoverage.test.ts')) continue;
    for (const n of securityNumbersIn(readFileSync(absolute, 'utf8'))) {
      map.set(n, [...(map.get(n) ?? []), relative]);
    }
  }
  return map;
}

describe('the security suite verifies what it reports (§11.7)', () => {
  it('every path named by test:security exists', () => {
    const missing = listedPaths().filter((relative) => !existsSync(path.join(REPO_ROOT, relative)));
    expect(missing, `test:security names files that do not exist: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('every S-number a test claims is reachable by test:security', () => {
    const listed = new Set(listedPaths());
    const unreachable: string[] = [];

    for (const [n, files] of coverageMap()) {
      if (E2E_COVERED.has(n)) continue;
      const covered = files.some((file) => listed.has(file));
      if (!covered) {
        unreachable.push(
          `S${n} (${SECURITY_TESTS[n]}) lives in ${files.join(', ')}, none of which test:security runs`,
        );
      }
    }

    expect(unreachable, unreachable.join('\n')).toEqual([]);
  });

  it('every S1–S15 is written, or documented as not yet written', () => {
    const covered = coverageMap();
    const undocumented: string[] = [];

    for (const key of Object.keys(SECURITY_TESTS)) {
      const n = Number.parseInt(key, 10);
      if (covered.has(n)) continue;
      if (n in NOT_YET_WRITTEN) continue;
      undocumented.push(
        `S${n} (${SECURITY_TESTS[n]}) has no test and is not in NOT_YET_WRITTEN — ` +
          `write it, or record which milestone owns it and why`,
      );
    }

    expect(undocumented, undocumented.join('\n')).toEqual([]);
  });

  it('NOT_YET_WRITTEN does not claim a test that now exists', () => {
    // The reverse direction. Writing S12 in M8 and forgetting to remove it
    // from the exemption list would leave a false record of what is
    // missing — and, worse, would let the entry mask a later regression.
    const covered = coverageMap();
    const stale = Object.keys(NOT_YET_WRITTEN)
      .map((key) => Number.parseInt(key, 10))
      .filter((n) => covered.has(n));
    expect(stale, `NOT_YET_WRITTEN still lists S${stale.join(', S')}, which now exists`).toEqual(
      [],
    );
  });

  it('S3 is where this milestone moved it, and the suite runs it there', () => {
    // Named explicitly, not implied by the general rule above: S3's move
    // out of ruleLoader.test.ts is what motivated this whole file, and a
    // general assertion that happens to cover it is easy to weaken later
    // without noticing.
    const files = coverageMap().get(3) ?? [];
    expect(files).toContain('tests/integration/packs/s3PackWidening.test.ts');
    expect(listedPaths()).toContain('tests/integration/packs/s3PackWidening.test.ts');
  });
});
