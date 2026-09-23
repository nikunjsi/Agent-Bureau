import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  checkEngineVersionDrift,
  TESTED_ENGINE_VERSIONS,
} from '../../../src/main/engine/engineVersionDrift';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { PROBE_LIVENESS_CEILING_MS } from '../../../src/shared/engine/types';
import {
  buildResolvedPath,
  resolveBinaryAbsolutePath,
} from '../../../src/main/engine/resolvedPath';

/**
 * M11 S1-4 (Known Issues 2026-09-22, decision E-1). The pin claims which
 * CLI this build has been exercised against. Two things must hold for that
 * claim to be worth anything, and neither had a test:
 *
 *  1. **The pin and CI's install move together.** `ci.yml` installs the
 *     CLI the runner does not have; if it installs a version the pin does
 *     not name, CI proves nothing about the pinned one. This check is free.
 *  2. **The pin names a CLI that actually exists and reports that version.**
 *     Run where a real `claude` resolves — the dev box and the CI runner —
 *     it is the only check that would notice the pin drifting away from
 *     every CLI anyone runs, which is precisely how it reached 2.1.238
 *     against a 2.1.276 dev box.
 */

const CI_WORKFLOW = path.resolve('.github/workflows/ci.yml');

function ciInstalledClaudeCodeVersion(): string {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8');
  const matches = [...workflow.matchAll(/@anthropic-ai\/claude-code@([^\s"']+)/g)].map(
    (m) => m[1] as string,
  );
  expect(matches.length, `no @anthropic-ai/claude-code@<version> install in ${CI_WORKFLOW}`).toBe(
    1,
  );
  return matches[0] as string;
}

const resolvedPath = await buildResolvedPath();
const realClaudePath = resolveBinaryAbsolutePath('claude', resolvedPath);
if (realClaudePath === null) {
  console.log(
    '[engineVersionPin.test.ts] skipping the installed-CLI check: no claude CLI on this machine',
  );
}

describe('the tested-engine pin (M11 S1-4 / E-1)', () => {
  it('CI installs exactly the pinned version — the pin and ci.yml move together', () => {
    const pinned = TESTED_ENGINE_VERSIONS['claude-code'];
    expect(pinned, 'claude-code must have a pin').toBeDefined();
    expect(pinned).toHaveLength(1);
    expect(ciInstalledClaudeCodeVersion()).toBe(pinned?.[0]);
  });

  it.skipIf(realClaudePath === null)(
    'the CLI installed on this machine reports a pinned version — no drift against a real claude',
    async () => {
      const adapter = new ClaudeCodeAdapter();
      const result = await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });
      expect(result.installed, result.error ?? '').toBe(true);
      expect(result.version, 'the probe reports the CLI version').not.toBeNull();

      const drift = checkEngineVersionDrift('claude-code', result.version);
      expect(
        drift,
        `the installed CLI reports ${String(result.version)}, but TESTED_ENGINE_VERSIONS pins ` +
          `${JSON.stringify(TESTED_ENGINE_VERSIONS['claude-code'])} — move the pin and ci.yml together (E-1)`,
      ).toBeNull();
    },
    PROBE_LIVENESS_CEILING_MS + 10_000,
  );
});
