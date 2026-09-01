import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPricingYaml, computeCostFromTokens } from '../../../src/main/cost/pricingYaml';
import type { PricingTable } from '../../../src/shared/models/pricing';

const SAMPLE_TABLE: PricingTable = {
  version: 1,
  verified_at: '2026-08-29',
  verified_against: 'https://platform.claude.com/docs/en/about-claude/pricing',
  engines: {
    'claude-code': {
      models: {
        'claude-sonnet-5': {
          input_usd_per_million: 2.0,
          output_usd_per_million: 10.0,
          cache_write_usd_per_million: 2.5,
          cache_read_usd_per_million: 0.2,
        },
      },
      quota_reset: { kind: 'unknown' },
    },
  },
};

describe('loadPricingYaml (§11.5.1)', () => {
  it('parses a real YAML file on disk through the Zod schema', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-pricing-'));
    try {
      const filePath = path.join(tmpDir, 'pricing.yaml');
      writeFileSync(
        filePath,
        [
          'version: 1',
          'verified_at: "2026-08-29"',
          'verified_against: "https://example.invalid/pricing"',
          'engines:',
          '  claude-code:',
          '    models:',
          '      claude-sonnet-5:',
          '        input_usd_per_million: 2.00',
          '        output_usd_per_million: 10.00',
          '        cache_write_usd_per_million: 2.50',
          '        cache_read_usd_per_million: 0.20',
          '    quota_reset:',
          '      kind: unknown',
          '',
        ].join('\n'),
        'utf8',
      );
      const table = loadPricingYaml(filePath);
      expect(table.engines['claude-code']?.models['claude-sonnet-5']?.input_usd_per_million).toBe(2.0);
      expect(table.engines['claude-code']?.quota_reset).toEqual({ kind: 'unknown' });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed file rather than silently producing a partial table (fail closed, §21 invariant #6)', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-pricing-bad-'));
    try {
      const filePath = path.join(tmpDir, 'pricing.yaml');
      writeFileSync(filePath, 'version: "not-a-number"\n', 'utf8');
      expect(() => loadPricingYaml(filePath)).toThrow();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('computeCostFromTokens (§11.5.1, invariant #12)', () => {
  it('computes integer micros from all four token categories, rounded once at the end', () => {
    // 1000 tokens in @ $2/M = 2000 micros; 500 out @ $10/M = 5000 micros;
    // 100 cache_read @ $0.20/M = 20 micros; 100 cache_write @ $2.50/M = 250 micros.
    const cost = computeCostFromTokens(SAMPLE_TABLE, 'claude-code', 'claude-sonnet-5', {
      tokensIn: 1000,
      tokensOut: 500,
      tokensCacheRead: 100,
      tokensCacheWrite: 100,
    });
    expect(cost).toBe(2000 + 5000 + 20 + 250);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('treats null token counts as zero contribution, not as "unknown"', () => {
    const cost = computeCostFromTokens(SAMPLE_TABLE, 'claude-code', 'claude-sonnet-5', {
      tokensIn: 1000,
      tokensOut: null,
      tokensCacheRead: null,
      tokensCacheWrite: null,
    });
    expect(cost).toBe(2000);
  });

  it('returns null, never 0, when the model is null — "cost not reported" (§21, CLAUDE.md)', () => {
    const cost = computeCostFromTokens(SAMPLE_TABLE, 'claude-code', null, {
      tokensIn: 1000,
      tokensOut: 500,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
    });
    expect(cost).toBeNull();
  });

  it('returns null, never 0, when no rate entry exists for this engine+model', () => {
    const cost = computeCostFromTokens(SAMPLE_TABLE, 'claude-code', 'model-with-no-rate', {
      tokensIn: 1000,
      tokensOut: 500,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
    });
    expect(cost).toBeNull();
  });

  it('returns null, never 0, for an engine with no pricing entry at all', () => {
    const cost = computeCostFromTokens(SAMPLE_TABLE, 'generic-pty', 'whatever', {
      tokensIn: 1000,
      tokensOut: 500,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
    });
    expect(cost).toBeNull();
  });
});
