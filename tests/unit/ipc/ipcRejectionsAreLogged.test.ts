import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dispatchIpcCall, type MethodSchema } from '../../../src/main/ipc/router';
import { ipcOk } from '../../../src/shared/ipc/envelope';
import type { HandlerContext } from '../../../src/main/ipc/handlers';
import type { NewEventInput } from '../../../src/shared/models/event';

/**
 * AUDIT M0–M2 #20 — §4.2: *"An invalid payload is dropped and logged,
 * never coerced."* S14's name says the same.
 *
 * "Dropped" and "never coerced" were built and tested well. "Logged" was a
 * `console.error` in the main process, which in a packaged app reaches
 * neither the user nor anything a support bundle collects — so the half of
 * the rule that exists for *finding out it happened* went nowhere.
 *
 * The control channel already answers the same question at its own trust
 * boundary: a rejected origin or token is a `control.*` activity event at
 * `severity: security`. A renderer sending a payload no typed caller could
 * construct, or a request from a frame Bureau did not create, is the same
 * class of event at the IPC boundary, so it is recorded the same way.
 *
 * This file is the unit half. S14 (`s14RejectsBadPayload.spec.ts`) proves
 * the same thing against the real packaged app by reading `activity.jsonl`.
 */

const echoSchema: MethodSchema = {
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
};

function contextRecording(): { ctx: HandlerContext; events: NewEventInput[] } {
  const events: NewEventInput[] = [];
  const ctx = {
    activityLog: { logEvent: (input: NewEventInput) => void events.push(input) },
  } as unknown as HandlerContext;
  return { ctx, events };
}

afterEach(() => vi.restoreAllMocks());

describe('§4.2 / S14: an IPC rejection is logged somewhere durable (AUDIT #20)', () => {
  it('a malformed payload is recorded as ipc.payload_rejected, severity security', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, events } = contextRecording();
    const handler = vi.fn(() => ipcOk({ n: 1 }));

    const result = await dispatchIpcCall('settings.set', echoSchema, handler, ctx, true, {
      n: 'not a number',
    });

    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: 'system',
      type: 'ipc.payload_rejected',
      severity: 'security',
      payload: { channel: 'settings.set' },
    });
  });

  it('records WHERE the payload was wrong, never the value — a rejected payload may be exactly the thing not to write down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, events } = contextRecording();
    await dispatchIpcCall('settings.set', echoSchema, () => ipcOk({ n: 1 }), ctx, true, {
      n: 'sk-ant-THIS-LOOKS-LIKE-A-SECRET',
    });
    const written = JSON.stringify(events);
    expect(written).not.toContain('sk-ant-THIS-LOOKS-LIKE-A-SECRET');
    expect(events[0]?.payload).toMatchObject({ issues: [{ path: ['n'] }] });
  });

  it('a request from an unrecognised sender is recorded as ipc.sender_rejected', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, events } = contextRecording();
    await dispatchIpcCall('settings.set', echoSchema, () => ipcOk({ n: 1 }), ctx, false, { n: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'ipc.sender_rejected',
      severity: 'security',
      payload: { channel: 'settings.set' },
    });
  });

  it('a failure to log never turns a clean rejection into something else', async () => {
    // Fail closed in the direction that matters: the request is still
    // refused with the same code. A logging fault must not become an
    // INTERNAL_ERROR, and above all must not let the call through.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = {
      activityLog: {
        logEvent: () => {
          throw new Error('disk full');
        },
      },
    } as unknown as HandlerContext;
    const handler = vi.fn(() => ipcOk({ n: 1 }));
    const result = await dispatchIpcCall('settings.set', echoSchema, handler, ctx, true, {
      n: 'bad',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('a successful call logs nothing — rejections are signals, not a request log', async () => {
    const { ctx, events } = contextRecording();
    await dispatchIpcCall('settings.set', echoSchema, () => ipcOk({ n: 1 }), ctx, true, { n: 1 });
    expect(events).toHaveLength(0);
  });
});
