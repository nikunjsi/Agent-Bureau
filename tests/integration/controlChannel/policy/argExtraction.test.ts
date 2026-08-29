import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractArgs } from '../../../../src/main/controlChannel/policy/argExtraction';
import { canonicalizePath } from '../../../../src/main/controlChannel/policy/pathCanonicalize';

describe('extractArgs (§11.3: canonical argument string is tool-specific and defined by the adapter)', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(path.join(tmpdir(), 'bureau-argextract-'));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  describe('read/write classes — resolved absolute path', () => {
    it('prefers file_path over path when both are present', () => {
      const target = path.join(worktree, 'a.ts');
      const result = extractArgs('write', { file_path: target, path: 'wrong.ts' }, worktree);
      expect(result.canonicalPath).toBe(canonicalizePath(target));
      expect(result.canonicalArg).toBe(result.canonicalPath);
    });

    it('falls back to path when file_path is absent (Grep/Glob’s own arg shape)', () => {
      const target = path.join(worktree, 'src');
      const result = extractArgs('read', { path: target, pattern: 'TODO' }, worktree);
      expect(result.canonicalPath).toBe(canonicalizePath(target));
    });

    it('a relative path resolves against the employee’s own worktree, never the Core’s process.cwd()', () => {
      const result = extractArgs('read', { path: 'src/index.ts' }, worktree);
      expect(result.canonicalPath).toBe(canonicalizePath(path.join(worktree, 'src', 'index.ts')));
      // Specifically NOT resolved against process.cwd() (this test file's
      // own directory) — the bug this fix closed.
      expect(result.canonicalPath).not.toBe(canonicalizePath(path.resolve('src/index.ts')));
    });

    it('read with no explicit path at all defaults to the implied worktree/project — the common bare Grep/Glob call', () => {
      const result = extractArgs('read', { pattern: 'TODO' }, worktree);
      expect(result.canonicalPath).toBe(canonicalizePath(worktree));
    });

    it('write with no explicit path gets NO implied fallback — fails closed to null, never guesses a target', () => {
      const result = extractArgs('write', { content: 'x' }, worktree);
      expect(result.canonicalPath).toBeNull();
    });

    it('read with no explicit path AND no implied worktree/project (e.g. the Director) also fails closed to null', () => {
      const result = extractArgs('read', { pattern: 'TODO' }, null);
      expect(result.canonicalPath).toBeNull();
    });
  });

  describe('command class — whitespace-normalised command line', () => {
    it('collapses internal whitespace and trims', () => {
      const result = extractArgs('command', { command: '  git   status  ' }, null);
      expect(result.canonicalArg).toBe('git status');
      expect(result.canonicalPath).toBeNull();
    });

    it('a missing command field normalises to an empty string rather than throwing', () => {
      const result = extractArgs('command', {}, null);
      expect(result.canonicalArg).toBe('');
    });
  });

  describe('network class — domain extraction', () => {
    it('extracts and lowercases the hostname from a well-formed url', () => {
      const result = extractArgs('network', { url: 'https://API.GitHub.com/repos/x' }, null);
      expect(result.domain).toBe('api.github.com');
    });

    it('a malformed url extracts no domain, rather than throwing', () => {
      const result = extractArgs('network', { url: 'not a url' }, null);
      expect(result.domain).toBeNull();
    });

    it('no url field at all extracts no domain', () => {
      const result = extractArgs('network', {}, null);
      expect(result.domain).toBeNull();
    });
  });

  describe('other/bureau classes — canonical JSON, keys sorted', () => {
    it('produces the same canonicalArg regardless of key order in the raw args', () => {
      const a = extractArgs('other', { b: 1, a: 2 }, null);
      const b = extractArgs('other', { a: 2, b: 1 }, null);
      expect(a.canonicalArg).toBe(b.canonicalArg);
    });
  });
});
