import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dispatchIpcCall, type MethodSchema } from '../../../src/main/ipc/router';
import { ipcOk } from '../../../src/shared/ipc/envelope';
import { createIpcRateLimiter, RATE_LIMITED_CHANNELS } from '../../../src/main/ipc/rateLimit';
import type { HandlerContext } from '../../../src/main/ipc/handlers';

/**
 * AUDIT M0–M2 #22 — §17.2: "Every handler … rate-limits where abuse is
 * possible." Nothing did, and `RATE_LIMITED` was a reserved code with no
 * producer.
 *
 * Low severity while the renderer is the only permitted sender and nothing
 * over IPC spends money. **M11 changes that**: `chat.send` becomes a
 * Director turn, and a renderer bug that retries in a loop becomes a bill.
 * So the limit is a per-channel token bucket on a NAMED list of expensive
 * methods — not all 109, where a limit on `settings.get` would only ever
 * find bugs in the limiter.
 */

const schema: MethodSchema = { input: z.object({}), output: z.object({ ok: z.literal(true) }) };
const ctx = { activityLog: { logEvent: () => undefined } } as unknown as HandlerContext;
afterEach(() => vi.restoreAllMocks());

describe('§17.2: IPC rate limiting on expensive methods (AUDIT #22)', () => {
  it('names the methods M11 makes expensive, and only a handful', () => {
    expect(RATE_LIMITED_CHANNELS).toEqual(
      expect.arrayContaining(['chat.send', 'memory.write', 'packs.install']),
    );
    expect(RATE_LIMITED_CHANNELS.length).toBeLessThan(10);
  });

  it('a loop is stopped: calls beyond the burst are refused with RATE_LIMITED before the handler runs', async () => {
    const now = 0;
    const limiter = createIpcRateLimiter(() => now);
    const handler = vi.fn(() => ipcOk({ ok: true as const }));
    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push(await dispatchIpcCall('chat.send', schema, handler, ctx, true, {}, limiter));
    }
    const refused = results.filter((r) => !r.ok);
    expect(refused.length, 'fifty instant calls all went through').toBeGreaterThan(30);
    expect(refused[0]).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    expect(handler.mock.calls.length).toBe(50 - refused.length);
  });

  it('a person is never stopped: calls spaced at human speed all go through', async () => {
    let now = 0;
    const limiter = createIpcRateLimiter(() => now);
    const handler = vi.fn(() => ipcOk({ ok: true as const }));
    for (let i = 0; i < 30; i++) {
      now += 2_000; // one message every two seconds, for a minute
      const r = await dispatchIpcCall('chat.send', schema, handler, ctx, true, {}, limiter);
      expect(r.ok, `call ${i} at human speed was refused`).toBe(true);
    }
  });

  it('the bucket refills — a burst that was refused is allowed again after a pause', async () => {
    let now = 0;
    const limiter = createIpcRateLimiter(() => now);
    const handler = () => ipcOk({ ok: true as const });
    for (let i = 0; i < 50; i++)
      await dispatchIpcCall('chat.send', schema, handler, ctx, true, {}, limiter);
    expect((await dispatchIpcCall('chat.send', schema, handler, ctx, true, {}, limiter)).ok).toBe(
      false,
    );
    now += 60_000;
    expect((await dispatchIpcCall('chat.send', schema, handler, ctx, true, {}, limiter)).ok).toBe(
      true,
    );
  });

  it('channels have separate buckets, and an unlisted channel is never limited', async () => {
    const now = 0;
    const limiter = createIpcRateLimiter(() => now);
    const handler = () => ipcOk({ ok: true as const });
    for (let i = 0; i < 50; i++)
      await dispatchIpcCall('chat.send', schema, handler, ctx, true, {}, limiter);
    expect(
      (await dispatchIpcCall('memory.write', schema, handler, ctx, true, {}, limiter)).ok,
    ).toBe(true);
    for (let i = 0; i < 500; i++) {
      const r = await dispatchIpcCall('settings.get', schema, handler, ctx, true, {}, limiter);
      expect(r.ok).toBe(true);
    }
  });

  it('a refused call carries plain language and a next action, not the code as prose', async () => {
    const now = 0;
    const limiter = createIpcRateLimiter(() => now);
    const handler = () => ipcOk({ ok: true as const });
    let last;
    for (let i = 0; i < 50; i++)
      last = await dispatchIpcCall('packs.install', schema, handler, ctx, true, {}, limiter);
    expect(last).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED', action: { type: 'retry' } },
    });
    if (last && !last.ok) expect(last.error.message).not.toContain('RATE_LIMITED');
  });
});
