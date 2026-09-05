/**
 * §7.8 test 10 / §27 risk 15 — engine version drift.
 *
 * "Version drift outside the tested range fires
 * `employee.engine_version_drift`." Before AUDIT #6 this existed only as a
 * function defined inside the contract test that asserted against it, so
 * the test passed while nothing in `src/` ever emitted the event and no
 * tested-version pin existed outside that test file.
 *
 * What this is NOT: immunity. Detection tells the user the engine they are
 * running was never validated against this build; it cannot stop a changed
 * output format from breaking parsing. §27 risk 15 states that honestly and
 * this module does not change it.
 */

/**
 * The engine versions this build has actually been exercised against.
 * `claude-code`'s pin is the version M3 validated for real against the
 * installed CLI (see `claudeCodeAdapterProbe.test.ts`) — not a guess, and
 * not a range: a single known-good version, because that is genuinely all
 * that has been tested.
 *
 * An engine absent from this map has no pin, so nothing can drift.
 */
export const TESTED_ENGINE_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  'claude-code': ['2.1.238'],
};

export interface EngineVersionDrift {
  readonly engineKey: string;
  readonly reportedVersion: string;
  readonly testedVersions: readonly string[];
}

/**
 * Returns the drift record when `reportedVersion` is outside the tested
 * set for this engine, or `null` when it matches (or when there is no pin
 * to compare against, or the engine reported no version at all — neither
 * is drift, and inventing one would make the signal meaningless).
 */
export function checkEngineVersionDrift(
  engineKey: string,
  reportedVersion: string | null,
): EngineVersionDrift | null {
  if (reportedVersion === null) return null;
  const testedVersions = TESTED_ENGINE_VERSIONS[engineKey];
  if (!testedVersions || testedVersions.length === 0) return null;
  if (testedVersions.includes(reportedVersion)) return null;
  return { engineKey, reportedVersion, testedVersions };
}
