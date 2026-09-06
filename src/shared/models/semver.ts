import { z } from 'zod';

/**
 * §6.7 check 1 — `bureau_min_version` has to be compared against the running
 * app's version, and that is the only version comparison this product does.
 *
 * Hand-rolled rather than depending on `semver` for one comparison, and
 * deliberately **strict** rather than lenient: the schema below rejects
 * anything that is not exactly `major.minor.patch`, so prerelease
 * (`1.0.0-beta`) and build metadata (`1.0.0+build.5`) are refused loudly at
 * parse time instead of being silently mis-ordered by a comparator that does
 * not implement their precedence rules. Supporting the full grammar later is a
 * deliberate extension; half-implementing it now would be the kind of subtle
 * wrongness that never surfaces until it matters.
 */
const STRICT_SEMVER = /^\d+\.\d+\.\d+$/;

export const StrictSemverSchema = z
  .string()
  .regex(
    STRICT_SEMVER,
    'must be exactly major.minor.patch (prerelease and build metadata are not supported)',
  );

/** Parses a version already known to match `StrictSemverSchema`. */
function parts(version: string): [number, number, number] {
  const [major, minor, patch] = version.split('.').map((n) => Number.parseInt(n, 10));
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

/**
 * `-1` if `a < b`, `0` if equal, `1` if `a > b`. Both arguments MUST already
 * have passed `StrictSemverSchema` — this only ever sees three integers, which
 * is the entire point of validating the shape upstream.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/** True when `available` is at least `required` — §6.7 check 1's actual question. */
export function satisfiesMinVersion(available: string, required: string): boolean {
  return compareSemver(available, required) >= 0;
}
