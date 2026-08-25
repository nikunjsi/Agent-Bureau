import { PolicyCheckResponseSchema } from './schemas';

export interface PolicyCheckOutcome {
  verdict: 'allow' | 'deny';
  reason: string;
}

/**
 * §7.10 / CLAUDE.md invariant #6: "fail closed... unreachable policy
 * check... -> the safe option." This is the one function that encodes
 * that contract for whoever calls POST /v1/policy/check — the real
 * bureau-hook (M4 session 2) will call exactly this, unchanged. Proven
 * here, session 1, because "Core dies mid-hold -> deny" is testable the
 * moment the server exists, even before bureau-hook itself does (M4
 * session 1 prompt: "this is the first time it is testable").
 *
 * Takes a `send` function rather than performing the HTTP call itself, so
 * the fail-closed *logic* has exactly one implementation exercised by both
 * a real server (integration: kill the Core process mid-hold, for real)
 * and a fake one that simulates specific failure shapes (unit), instead of
 * two copies of the same judgment call that could quietly diverge.
 */
export async function checkPolicyFailClosed(
  send: () => Promise<{ status: number; body: unknown }>,
): Promise<PolicyCheckOutcome> {
  let response: { status: number; body: unknown };
  try {
    response = await send();
  } catch (err) {
    // Transport failure: connection refused, reset mid-hold (the Core
    // process died), DNS failure — anything that means no verdict was
    // ever actually received. Fail closed. Never allow on "I don't know."
    return { verdict: 'deny', reason: `transport failure: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (response.status !== 200) {
    return { verdict: 'deny', reason: `unexpected HTTP status ${response.status}` };
  }

  const parsed = PolicyCheckResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    return { verdict: 'deny', reason: 'malformed /v1/policy/check response body' };
  }
  if (parsed.data.verdict !== 'allow') {
    return { verdict: 'deny', reason: parsed.data.reason ?? 'server denied' };
  }
  return { verdict: 'allow', reason: parsed.data.reason ?? 'allowed' };
}
