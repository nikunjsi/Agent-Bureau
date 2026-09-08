import fs from 'node:fs';
import path from 'node:path';

/** §10.4: "a secret scan validator is on by default and cannot be
 * disabled — an agent accidentally committing a key is a realistic and
 * very costly failure." Deliberately only high-confidence, structurally
 * distinctive patterns (a real credential's own recognizable shape) —
 * no generic entropy heuristic. A mandatory, undisableable validator
 * (`validators.ts` refuses to run without it, M5 part 2 plan D5) can't
 * afford false-positive noise; a narrower, precise pattern set that
 * never fires on ordinary code is the only way a "cannot be turned off"
 * validator stays usable.
 */
export interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

// Every pattern is `g`-flagged (findAllMatches needs every occurrence,
// not just the first) and anchored to a real, well-known credential
// prefix/shape — not a bare "looks random" heuristic.
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-token', pattern: /\bgh[opusr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe-live-key', pattern: /\bsk_live_[0-9a-zA-Z]{24,}\b/g },
  {
    name: 'private-key-header',
    pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH|PGP)?\s?PRIVATE KEY-----/g,
  },
];

export interface SecretFinding {
  readonly file: string;
  readonly pattern: string;
  /** The matched text, not the surrounding line — never log more of the
   * secret's own context than necessary, even in the finding meant to
   * help someone fix it. */
  readonly match: string;
}

/** Pure — scans one file's already-read content. Exported separately so
 * `secretScan.test.ts` can prove every pattern (and the false-positive
 * case) without touching a filesystem. */
export function scanContentForSecrets(filePath: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    // A fresh RegExp per call — `pattern` is a shared module-level
    // constant, and a `g`-flagged regex is stateful (`.lastIndex`);
    // reusing the same instance across files would silently skip
    // matches depending on call order.
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of content.matchAll(re)) {
      findings.push({ file: filePath, pattern: name, match: match[0] });
    }
  }
  return findings;
}

/**
 * Scans every file `git status --porcelain` reports as changed —
 * reading current on-disk content directly (covers new/untracked files
 * a HEAD-diff would miss) rather than parsing diff output. `changedFiles`
 * is the caller's job to produce (from `git status --porcelain`'s own
 * parsed output, `validators.ts`'s concern, not this pure-scanning
 * module's).
 */
export function scanFilesForSecrets(
  worktreePath: string,
  changedFiles: readonly string[],
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const relativePath of changedFiles) {
    const absolutePath = path.join(worktreePath, relativePath);
    let content: string;
    try {
      content = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      // Deleted file (git status still lists it as "changed") or a
      // binary file that can't be read as utf8 without corrupting the
      // comparison — neither is a secret-scanning concern; skip.
      continue;
    }
    findings.push(...scanContentForSecrets(relativePath, content));
  }
  return findings;
}
