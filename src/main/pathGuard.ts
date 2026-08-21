import path from 'node:path';

/**
 * Resolves an `app://` request URL to an absolute path inside `distRoot`,
 * or returns `null` if the request would escape it after normalisation.
 * This is a path-traversal guard, not a convenience — kept in its own
 * module (no Electron import) so it is a pure, fast unit test (§19.1) with
 * no dependency on the Electron binary being present at all.
 */
export function resolveInsideDist(requestUrl: string, distRoot: string): string | null {
  let pathname: string;
  try {
    const parsed = new URL(requestUrl);
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  if (pathname === '' || pathname === '/') {
    pathname = '/index.html';
  }

  const normalizedRoot = path.normalize(distRoot);
  const resolved = path.normalize(path.join(normalizedRoot, pathname));

  const isInsideRoot =
    resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep);

  return isInsideRoot ? resolved : null;
}
