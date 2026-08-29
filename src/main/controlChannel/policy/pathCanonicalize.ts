import { realpathSync } from 'node:fs';
import path from 'node:path';

function toCanonicalSlashes(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * §11.3 MUST: "resolve with `fs.realpathSync.native` (collapses junctions,
 * symlinks and 8.3 short names like `PROGRA~1`), convert `\` to `/`, and
 * lowercase for comparison. Without this, `C:\Windows\...` never matches
 * `C:/Windows/**` and every system-path deny silently fails."
 *
 * `realpathSync.native` requires the full path to already exist, which is
 * wrong for the single most common case a policy check needs to handle: a
 * `Write`/`Edit` targeting a file that doesn't exist yet. Naively calling
 * it on the full path would throw `ENOENT` on every new-file write.
 *
 * This walks up from the full path to the longest EXISTING ancestor,
 * canonicalises that ancestor (collapsing any junction/8.3 name along the
 * real, existing part of the path), then re-joins the remaining
 * not-yet-existing segments, normalised (slashes, case) but not
 * re-resolved (there is nothing on disk yet to resolve). A path with no
 * existing ancestor at all (a bogus drive letter) falls back to
 * normalising the raw input rather than throwing — canonicalisation
 * failing closed just means "this matches no allow rule", which is the
 * correct behaviour for garbage input regardless of why it's garbage.
 */
export function canonicalizePath(inputPath: string): string {
  let current = path.resolve(inputPath);
  const remainder: string[] = [];

  for (;;) {
    try {
      const real = realpathSync.native(current);
      const base = toCanonicalSlashes(real);
      return remainder.length === 0 ? base : `${base}/${remainder.join('/').toLowerCase()}`;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // No existing ancestor at all — fail closed on the normalised raw input.
        return toCanonicalSlashes(path.resolve(inputPath));
      }
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}
