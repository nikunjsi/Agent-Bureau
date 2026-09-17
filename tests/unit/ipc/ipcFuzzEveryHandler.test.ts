import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { allIpcChannels } from '../../../src/shared/ipc/methodList';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { getHandler } from '../../../src/main/ipc/handlers';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

/**
 * T-4 (§19, IPC): **every** handler fuzzed with malformed payloads. None
 * crashes, none coerces. S14 covers representative cases only.
 *
 * Iterates `allIpcChannels()`, so a method added to `methodList.ts` is covered
 * with no edit here. For each method, payloads are generated (fixed hostile
 * shapes plus fast-check's `anything()`), and only those the method's real
 * input schema rejects are sent, through the real `dispatchIpcCall` with the
 * real schema and the real handler wrapped in a spy. Each must come back as a
 * typed `VALIDATION_FAILED`, must not throw, and must never reach the handler:
 * a handler that ran on a rejected payload would be acting on a coerced one.
 */
const HOSTILE: unknown[] = [
  null,
  undefined,
  0,
  -1,
  Number.NaN,
  '',
  'x'.repeat(10_000),
  true,
  [],
  [{}],
  () => 'fn',
  { __proto__: { polluted: true } },
  { constructor: { prototype: { polluted: true } } },
  { id: 12 },
  { id: '../../etc/passwd' },
  { conversationId: { $ne: null } },
  { projectId: ['a'] },
  { value: Symbol.for('x') },
];

function recordingContext(): HandlerContext {
  return {
    activityLog: { logEvent: () => undefined },
  } as unknown as HandlerContext;
}

describe('T-4: every IPC handler rejects malformed payloads without crashing or coercing (fuzz)', () => {
  const channels = allIpcChannels();

  it('covers every method in methodList.ts (guards the loop against its own vacuity)', () => {
    expect(channels.length).toBeGreaterThan(100);
  });

  it.each(channels.map((c) => [c.channel, c] as const))('%s', async (_name, entry) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const schema = getMethodSchema(entry.namespace, entry.method);
    const realHandler = getHandler(entry.namespace, entry.method);
    const generated = fc.sample(fc.anything({ maxDepth: 2, withNullPrototype: true }), {
      numRuns: 60,
      seed: 17,
    });
    const malformed = [...HOSTILE, ...generated].filter(
      (payload) => !schema.input.safeParse(payload).success,
    );
    // Every method has SOME payload shape it refuses; a schema that accepts
    // everything is not validating anything.
    expect(malformed.length, `${entry.channel} rejected none of the payloads`).toBeGreaterThan(0);

    for (const payload of malformed) {
      const handler = vi.fn(realHandler);
      let result: Awaited<ReturnType<typeof dispatchIpcCall>> | undefined;
      await expect(
        (async () => {
          result = await dispatchIpcCall(
            entry.channel,
            schema,
            handler,
            recordingContext(),
            true,
            payload,
          );
        })(),
      ).resolves.toBeUndefined();
      expect(
        handler,
        `${entry.channel} ran its handler on a rejected payload`,
      ).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
  });
});
