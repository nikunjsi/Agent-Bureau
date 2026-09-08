import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalizePath } from '../../../../src/main/controlChannel/policy/pathCanonicalize';

/**
 * §11.3 MUST + risk register row 5 (Not started since M0 — this is its
 * mitigation): real 8.3 short names and a real junction, not synthetic
 * strings with a backslash in them. Both fixtures were verified against
 * this actual machine before being written into assertions here (not
 * assumed): `C:\PROGRA~1` is confirmed live via `dir /x C:\`, and
 * `fs.symlinkSync(..., 'junction')` was confirmed to work without admin
 * rights via a standalone probe.
 */
describe('canonicalizePath (§11.3 MUST — realpathSync.native, slashes, lowercase)', () => {
  it('collapses a real 8.3 short name to the real long path, lowercased, forward-slashed', () => {
    const canonical = canonicalizePath('C:\\PROGRA~1');
    expect(canonical).toBe('c:/program files');
  });

  it('a lowercase C:/Windows/... form and a Windows-cased C:\\Windows\\... form canonicalise identically', () => {
    const a = canonicalizePath('C:\\Windows');
    const b = canonicalizePath('c:/windows');
    expect(a).toBe(b);
    expect(a).toBe('c:/windows');
  });

  describe('a real NTFS junction', () => {
    let base: string;
    let realTarget: string;
    let junctionLink: string;

    beforeEach(() => {
      base = mkdtempSync(path.join(tmpdir(), 'bureau-canon-junction-'));
      realTarget = path.join(base, 'real-target');
      mkdirSync(realTarget);
      writeFileSync(path.join(realTarget, 'file.txt'), 'hi', 'utf8');
      junctionLink = path.join(base, 'junction-link');
      symlinkSync(realTarget, junctionLink, 'junction');
    });

    afterEach(() => {
      rmSync(base, { recursive: true, force: true });
    });

    it('resolves a path through the junction to the real target path', () => {
      const viaJunction = canonicalizePath(path.join(junctionLink, 'file.txt'));
      const viaReal = canonicalizePath(path.join(realTarget, 'file.txt'));
      expect(viaJunction).toBe(viaReal);
    });
  });

  describe('a path that does not exist yet — the common Write/Edit case', () => {
    let existingDir: string;

    beforeEach(() => {
      existingDir = mkdtempSync(path.join(tmpdir(), 'bureau-canon-newfile-'));
    });

    afterEach(() => {
      rmSync(existingDir, { recursive: true, force: true });
    });

    it('does not throw, and canonicalises the existing ancestor while preserving the new segment', () => {
      const target = path.join(existingDir, 'brand-new-file.ts');
      expect(() => canonicalizePath(target)).not.toThrow();
      const canonical = canonicalizePath(target);
      expect(canonical.endsWith('/brand-new-file.ts')).toBe(true);
      expect(canonical.startsWith(canonicalizePath(existingDir))).toBe(true);
    });

    it('works several levels of non-existent nesting deep', () => {
      const target = path.join(existingDir, 'a', 'b', 'c', 'deep.ts');
      const canonical = canonicalizePath(target);
      expect(canonical.endsWith('/a/b/c/deep.ts')).toBe(true);
    });
  });

  it('a fully bogus drive falls back to normalising the raw input rather than throwing', () => {
    expect(() =>
      canonicalizePath('Z:\\this\\drive\\should\\not\\exist\\on\\this\\machine'),
    ).not.toThrow();
    const canonical = canonicalizePath('Z:\\this\\drive\\should\\not\\exist\\on\\this\\machine');
    expect(canonical).toBe('z:/this/drive/should/not/exist/on/this/machine');
  });
});
