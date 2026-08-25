import { describe, expect, it } from 'vitest';
import { checkPolicyFailClosed } from '../../../src/shared/controlChannel/policyCheckClient';

describe('checkPolicyFailClosed (CLAUDE.md invariant #6: fail closed on anything but a real allow)', () => {
  it('passes through a real allow verdict', async () => {
    const outcome = await checkPolicyFailClosed(async () => ({
      status: 200,
      body: { verdict: 'allow', ruleId: null, reason: null },
    }));
    expect(outcome.verdict).toBe('allow');
  });

  it('passes through a real deny verdict', async () => {
    const outcome = await checkPolicyFailClosed(async () => ({
      status: 200,
      body: { verdict: 'deny', ruleId: 'r1', reason: 'not on the allow-list' },
    }));
    expect(outcome.verdict).toBe('deny');
    expect(outcome.reason).toBe('not on the allow-list');
  });

  it('denies on a transport failure (connection refused/reset — the Core process is unreachable)', async () => {
    const outcome = await checkPolicyFailClosed(async () => {
      throw new Error('ECONNRESET');
    });
    expect(outcome.verdict).toBe('deny');
    expect(outcome.reason).toMatch(/transport failure/);
  });

  it('denies on a non-200 status', async () => {
    const outcome = await checkPolicyFailClosed(async () => ({ status: 500, body: {} }));
    expect(outcome.verdict).toBe('deny');
  });

  it('denies on a malformed response body', async () => {
    const outcome = await checkPolicyFailClosed(async () => ({ status: 200, body: { not: 'a verdict' } }));
    expect(outcome.verdict).toBe('deny');
  });

  it('denies on a response body that somehow claims a third state — never trusts anything but the literal string "allow"', async () => {
    const outcome = await checkPolicyFailClosed(async () => ({
      status: 200,
      body: { verdict: 'ask', ruleId: null, reason: null },
    }));
    expect(outcome.verdict).toBe('deny');
  });
});
