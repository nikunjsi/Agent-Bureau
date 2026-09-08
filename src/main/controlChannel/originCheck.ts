/**
 * §7.10/M4 step 1: "Reject any non-loopback origin — test it; do not
 * assume binding to loopback is sufficient." Binding to `127.0.0.1`
 * (never `0.0.0.0`) already makes it physically impossible for a remote
 * network address to reach this server — that part genuinely doesn't need
 * a test, the OS enforces it. What DOES need checking, because it's a
 * real, known vulnerability class for "just" loopback-bound local
 * servers: a malicious web page running in the user's own browser can
 * still `fetch('http://127.0.0.1:<port>/...')` — the browser happily
 * connects to loopback — and DNS rebinding can make that request's `Host`
 * header claim an attacker's domain instead of `127.0.0.1`. `bureau-hook`/
 * `bureau-tools` are plain Node HTTP clients, never a browser context, so
 * they never send an `Origin` header at all and always address the
 * server by its literal `127.0.0.1:<port>` — a request that violates
 * either of those is not one of them, whatever else it looks like.
 *
 * A pure function, deliberately: it can be tested directly against
 * adversarial-shaped inputs (a non-loopback remoteAddress, a browser-
 * shaped Origin header, a rebound Host header) without needing to somehow
 * establish a real non-loopback TCP connection to a 127.0.0.1-bound
 * server, which the OS makes impossible to do for real.
 */
export interface OriginCheckInput {
  remoteAddress: string | undefined;
  originHeader: string | undefined;
  hostHeader: string | undefined;
  expectedPort: number;
}

export interface OriginCheckResult {
  ok: boolean;
  reason: string;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function checkRequestOrigin(input: OriginCheckInput): OriginCheckResult {
  if (!input.remoteAddress || !LOOPBACK_ADDRESSES.has(input.remoteAddress)) {
    return {
      ok: false,
      reason: `remote address "${input.remoteAddress ?? 'unknown'}" is not loopback`,
    };
  }
  if (input.originHeader !== undefined) {
    return {
      ok: false,
      reason:
        'Origin header present — only a browser context sends one; bureau-hook/bureau-tools never do',
    };
  }
  const expectedHosts = new Set([
    `127.0.0.1:${input.expectedPort}`,
    `localhost:${input.expectedPort}`,
  ]);
  if (!input.hostHeader || !expectedHosts.has(input.hostHeader)) {
    return {
      ok: false,
      reason: `Host header "${input.hostHeader ?? 'missing'}" does not match this server's own 127.0.0.1:${input.expectedPort} — possible DNS rebinding`,
    };
  }
  return { ok: true, reason: 'ok' };
}
