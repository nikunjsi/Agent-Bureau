import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveInsideDist } from '../../src/main/pathGuard';

const DIST_ROOT = path.normalize('C:\\app\\dist\\renderer');

function inside(...segments: string[]): string {
  return path.normalize(path.join(DIST_ROOT, ...segments));
}

describe('resolveInsideDist (§18.1.1 path-traversal guard)', () => {
  it('resolves the root path to index.html', () => {
    expect(resolveInsideDist('app://bureau/', DIST_ROOT)).toBe(inside('index.html'));
  });

  it('resolves a path with no trailing slash to index.html too', () => {
    expect(resolveInsideDist('app://bureau', DIST_ROOT)).toBe(inside('index.html'));
  });

  it('resolves a nested asset path inside the root', () => {
    expect(resolveInsideDist('app://bureau/assets/index-abc123.js', DIST_ROOT)).toBe(
      inside('assets', 'index-abc123.js'),
    );
  });

  it('rejects a malformed URL', () => {
    expect(resolveInsideDist('not a url', DIST_ROOT)).toBeNull();
  });

  // A literal "../" in the URL, and its %2e%2e-encoded form, are both
  // dot-segments the URL Standard's own parser already collapses before
  // resolveInsideDist ever sees them (verified against Node's URL
  // implementation) — they land safely inside the root rather than
  // escaping, which is correct, if not the most interesting case.
  it('neutralises a literal ../ before it reaches the guard (still lands inside root)', () => {
    const resolved = resolveInsideDist('app://bureau/../../secrets.txt', DIST_ROOT);
    expect(resolved).toBe(inside('secrets.txt'));
  });

  // Encoding the *slash* (not the dots) survives the URL parser's
  // dot-segment collapsing, because it no longer sees "assets" and ".." as
  // separate path segments — this is the case resolveInsideDist's own
  // normalise-then-prefix-check has to catch, and the one that actually
  // proves the guard does something.
  it('rejects a traversal attempt that survives URL parsing via an encoded slash', () => {
    expect(resolveInsideDist('app://bureau/..%2f..%2fsecrets.txt', DIST_ROOT)).toBeNull();
  });

  it('rejects a deeper encoded-slash traversal that would land above the drive root', () => {
    expect(
      resolveInsideDist('app://bureau/assets/..%2f..%2f..%2fwindows/win.ini', DIST_ROOT),
    ).toBeNull();
  });
});
