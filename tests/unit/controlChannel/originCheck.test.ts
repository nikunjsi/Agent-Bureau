import { describe, expect, it } from 'vitest';
import { checkRequestOrigin } from '../../../src/main/controlChannel/originCheck';

describe('checkRequestOrigin (§7.10/M4 step 1: "reject any non-loopback origin — test it")', () => {
  const base = { remoteAddress: '127.0.0.1', originHeader: undefined, hostHeader: '127.0.0.1:5555', expectedPort: 5555 };

  it('accepts a well-formed loopback request with no Origin header and a matching Host header', () => {
    expect(checkRequestOrigin(base).ok).toBe(true);
  });

  it('accepts localhost as an equally valid Host header', () => {
    expect(checkRequestOrigin({ ...base, hostHeader: 'localhost:5555' }).ok).toBe(true);
  });

  it('accepts the IPv6 loopback remote address', () => {
    expect(checkRequestOrigin({ ...base, remoteAddress: '::1' }).ok).toBe(true);
  });

  it('rejects a non-loopback remote address', () => {
    const result = checkRequestOrigin({ ...base, remoteAddress: '192.168.1.50' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not loopback/);
  });

  it('rejects a missing remote address', () => {
    const result = checkRequestOrigin({ ...base, remoteAddress: undefined });
    expect(result.ok).toBe(false);
  });

  it('rejects any request carrying an Origin header — a browser-shaped request is never bureau-hook/bureau-tools', () => {
    const result = checkRequestOrigin({ ...base, originHeader: 'http://evil.example' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Origin header present/);
  });

  it('rejects an Origin header even when it claims to be loopback itself — presence alone is disqualifying', () => {
    const result = checkRequestOrigin({ ...base, originHeader: 'http://127.0.0.1:5555' });
    expect(result.ok).toBe(false);
  });

  it('rejects a Host header naming a different port than the one actually bound (DNS-rebinding-shaped)', () => {
    const result = checkRequestOrigin({ ...base, hostHeader: '127.0.0.1:9999' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/rebinding/);
  });

  it('rejects a Host header naming an attacker domain', () => {
    const result = checkRequestOrigin({ ...base, hostHeader: 'evil.example:5555' });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing Host header', () => {
    const result = checkRequestOrigin({ ...base, hostHeader: undefined });
    expect(result.ok).toBe(false);
  });
});
