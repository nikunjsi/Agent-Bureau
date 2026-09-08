import { describe, expect, it } from 'vitest';
import { scanContentForSecrets } from '../../../src/main/workspace/secretScan';

describe('scanContentForSecrets (§10.4 — mandatory secret scan)', () => {
  it('detects an AWS access key id', () => {
    const findings = scanContentForSecrets('config.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pattern).toBe('aws-access-key-id');
  });

  it('detects each real GitHub token prefix', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
      const token = `${prefix}${'a'.repeat(36)}`;
      const findings = scanContentForSecrets('f.ts', `TOKEN=${token}`);
      expect(
        findings.some((f) => f.pattern === 'github-token'),
        `expected a match for ${prefix}`,
      ).toBe(true);
    }
  });

  it('detects a Slack token', () => {
    const findings = scanContentForSecrets('f.ts', 'xoxb-1234567890-abcdefghijklmnop');
    expect(findings.some((f) => f.pattern === 'slack-token')).toBe(true);
  });

  it('detects a Google API key', () => {
    const findings = scanContentForSecrets('f.ts', `AIza${'A'.repeat(35)}`);
    expect(findings.some((f) => f.pattern === 'google-api-key')).toBe(true);
  });

  it('detects a Stripe live key', () => {
    const findings = scanContentForSecrets('f.ts', `sk_live_${'a'.repeat(24)}`);
    expect(findings.some((f) => f.pattern === 'stripe-live-key')).toBe(true);
  });

  it('detects a PEM private key header, any variant', () => {
    for (const variant of ['RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'PGP ', '']) {
      const findings = scanContentForSecrets(
        'id_rsa',
        `-----BEGIN ${variant}PRIVATE KEY-----\nMIIExyz\n-----END ${variant}PRIVATE KEY-----`,
      );
      expect(
        findings.some((f) => f.pattern === 'private-key-header'),
        `expected a match for "${variant}"`,
      ).toBe(true);
    }
  });

  it('finds every occurrence, not just the first, across multiple files worth of content', () => {
    const content = 'AKIAIOSFODNN7EXAMPLE\nsome code\nAKIABBBBBBBBBBBBBBBB';
    const findings = scanContentForSecrets('f.ts', content);
    expect(findings).toHaveLength(2);
  });

  it('does not false-positive on ordinary code', () => {
    const ordinaryCode = `
      import { readFile } from 'node:fs/promises';
      export async function loadConfig(path: string) {
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw) as { apiKeyRef: string; ghOrg: string };
      }
      // A comment mentioning "private key" in prose, not a real PEM block.
      const description = 'stores the user private key reference, not the key itself';
    `;
    expect(scanContentForSecrets('config.ts', ordinaryCode)).toEqual([]);
  });

  it('does not match a same-length random string missing the real prefix', () => {
    // 20 base32-ish chars, same length as an AWS key id, but no AKIA prefix.
    expect(scanContentForSecrets('f.ts', 'XYZWABCDEF1234567890')).toEqual([]);
  });
});
