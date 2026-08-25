import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../../src/main/controlChannel/rateLimiter';

describe('RateLimiter (§7.9: bureau_report_status rate-limited to 1/3s, enforced server-side)', () => {
  it('allows the first call for a tool with a configured window', () => {
    const limiter = new RateLimiter({ bureau_report_status: 3000 });
    expect(limiter.checkAndRecord('emp1', 'bureau_report_status', 1000)).toBe(true);
  });

  it('rejects a second call inside the configured window', () => {
    const limiter = new RateLimiter({ bureau_report_status: 3000 });
    expect(limiter.checkAndRecord('emp1', 'bureau_report_status', 1000)).toBe(true);
    expect(limiter.checkAndRecord('emp1', 'bureau_report_status', 2000)).toBe(false);
  });

  it('allows a call once the window has elapsed', () => {
    const limiter = new RateLimiter({ bureau_report_status: 3000 });
    expect(limiter.checkAndRecord('emp1', 'bureau_report_status', 1000)).toBe(true);
    expect(limiter.checkAndRecord('emp1', 'bureau_report_status', 4001)).toBe(true);
  });

  it('never rate-limits a tool with no configured window', () => {
    const limiter = new RateLimiter({ bureau_report_status: 3000 });
    expect(limiter.checkAndRecord('emp1', 'bureau_other_tool', 1000)).toBe(true);
    expect(limiter.checkAndRecord('emp1', 'bureau_other_tool', 1001)).toBe(true);
  });

  it('tracks each employee independently — one employee hammering a tool does not affect another', () => {
    const limiter = new RateLimiter({ bureau_report_status: 3000 });
    expect(limiter.checkAndRecord('emp1', 'bureau_report_status', 1000)).toBe(true);
    expect(limiter.checkAndRecord('emp2', 'bureau_report_status', 1000)).toBe(true);
  });

  it('tracks each tool independently for the same employee', () => {
    const limiter = new RateLimiter({ bureau_report_status: 3000, other_tool: 3000 });
    expect(limiter.checkAndRecord('emp1', 'bureau_report_status', 1000)).toBe(true);
    expect(limiter.checkAndRecord('emp1', 'other_tool', 1000)).toBe(true);
  });
});
