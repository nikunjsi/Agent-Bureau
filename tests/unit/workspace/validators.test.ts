import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectValidators,
  runValidators,
  SECRET_SCAN_VALIDATOR_NAME,
  MissingSecretScanValidatorError,
  type Validator,
} from '../../../src/main/workspace/validators';

describe('detectValidators (§10.4/§28 M5 item 5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-validators-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('always includes secret-scan, even with no package.json at all (§10.2 non-code projects)', () => {
    const validators = detectValidators(tmpDir);
    expect(validators.map((v) => v.name)).toEqual([SECRET_SCAN_VALIDATOR_NAME]);
  });

  it('detects lint and test scripts when package.json has them', () => {
    writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } }));
    const validators = detectValidators(tmpDir);
    expect(validators.map((v) => v.name)).toEqual([SECRET_SCAN_VALIDATOR_NAME, 'lint', 'test']);
  });

  it('does not invent a lint/test validator the repo does not actually have', () => {
    writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    const validators = detectValidators(tmpDir);
    expect(validators.map((v) => v.name)).toEqual([SECRET_SCAN_VALIDATOR_NAME]);
  });

  it('overrides can skip lint/test individually — a legitimate future per-project setting', () => {
    writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } }));
    const validators = detectValidators(tmpDir, { lint: false });
    expect(validators.map((v) => v.name)).toEqual([SECRET_SCAN_VALIDATOR_NAME, 'test']);
  });

  it('overrides has no key capable of removing secret-scan — proven, not merely absent from the type', () => {
    writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    // A deliberate type-safety bypass: if some future caller tried to
    // sneak an extra key in, detectValidators must still never read it.
    const smuggledOverrides = { lint: false, secretScan: false } as unknown as Parameters<typeof detectValidators>[1];
    const validators = detectValidators(tmpDir, smuggledOverrides);
    expect(validators.map((v) => v.name)).toContain(SECRET_SCAN_VALIDATOR_NAME);
  });

  it('a malformed package.json does not crash detection — secret-scan still runs', () => {
    writeFileSync(path.join(tmpDir, 'package.json'), '{ not valid json');
    const validators = detectValidators(tmpDir);
    expect(validators.map((v) => v.name)).toEqual([SECRET_SCAN_VALIDATOR_NAME]);
  });
});

describe('runValidators (§10.4 enforcement point — D5)', () => {
  const passingValidator: Validator = { name: 'x', run: async () => ({ name: 'x', passed: true, output: '' }) };
  const failingValidator: Validator = { name: 'y', run: async () => ({ name: 'y', passed: false, output: 'boom' }) };
  const secretScanStub: Validator = {
    name: SECRET_SCAN_VALIDATOR_NAME,
    run: async () => ({ name: SECRET_SCAN_VALIDATOR_NAME, passed: true, output: 'no secrets detected' }),
  };

  it('refuses a hand-built validator list that omits secret-scan — the actual mandatory-ness proof, not an override-key check', async () => {
    // Never goes through detectValidators at all — this is exactly the
    // bypass D5 exists to guard against.
    await expect(runValidators('C:\\repo', 'C:\\wt', [passingValidator, failingValidator])).rejects.toThrow(
      MissingSecretScanValidatorError,
    );
  });

  it('runs every validator and reports allPassed=false with every failure collected, not just the first', async () => {
    const report = await runValidators('C:\\repo', 'C:\\wt', [secretScanStub, passingValidator, failingValidator]);
    expect(report.allPassed).toBe(false);
    expect(report.results).toHaveLength(3);
    expect(report.results.find((r) => r.name === 'y')?.output).toBe('boom');
  });

  it('reports allPassed=true when every validator, including secret-scan, passes', async () => {
    const report = await runValidators('C:\\repo', 'C:\\wt', [secretScanStub, passingValidator]);
    expect(report.allPassed).toBe(true);
  });
});
