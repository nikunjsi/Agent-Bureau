import { describe, expect, it } from 'vitest';
import {
  TESTED_ENGINE_VERSIONS,
  checkEngineVersionDrift,
} from '../../../src/main/engine/engineVersionDrift';

/**
 * M11 S1-3 (pre-M11 §F, P-9): the probe reports `claude --version`'s own
 * output, trimmed, and the real CLI prints `2.1.276 (Claude Code)` — not the
 * bare version the pin holds. Compared as raw strings, the tested version
 * itself drifted on every spawn, so `employee.engine_version_drift` fired
 * always and meant nothing. The comparison is on the leading semver.
 */
describe('checkEngineVersionDrift compares the leading semver of what the CLI reports', () => {
  const pinned = TESTED_ENGINE_VERSIONS['claude-code']?.[0] as string;

  it("the pinned version, in the real CLI's own output shape, is not drift", () => {
    expect(checkEngineVersionDrift('claude-code', `${pinned} (Claude Code)`)).toBeNull();
  });

  it('a different version in the same shape is drift, and the record keeps what the CLI said', () => {
    const drift = checkEngineVersionDrift('claude-code', '9.9.9 (Claude Code)');
    expect(drift).toMatchObject({
      engineKey: 'claude-code',
      reportedVersion: '9.9.9 (Claude Code)',
    });
  });

  it('a longer version that merely starts with the pin is drift (the match is anchored)', () => {
    expect(checkEngineVersionDrift('claude-code', `${pinned}0 (Claude Code)`)).not.toBeNull();
    expect(checkEngineVersionDrift('claude-code', `${pinned}.1`)).not.toBeNull();
  });

  it('output with no leading version at all is drift, not a silent match', () => {
    expect(checkEngineVersionDrift('claude-code', 'Claude Code')).not.toBeNull();
  });
});
