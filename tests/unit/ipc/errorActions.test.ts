import { describe, expect, it, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { dispatchIpcCall, type MethodSchema } from '../../../src/main/ipc/router';
import { ipcOk, IpcErrorActionSchema } from '../../../src/shared/ipc/envelope';
import type { HandlerContext } from '../../../src/main/ipc/handlers';

/**
 * AUDIT M0–M2 #16 — §14.6: *"Every error surfaced to the user MUST have:
 * what happened in plain language, why, and a concrete next action (a
 * button where possible). 'Error: ENOENT' reaching the user is a bug."*
 * CLAUDE.md says the same thing from the other side: *do not show raw
 * engine output to the user by default. Translate.*
 *
 * `router.ts` interpolated the raw thrown message straight into the
 * user-facing string:
 *
 *     `Something went wrong handling that request: ${message}`
 *
 * and two handlers threw raw `shell.openPath` failures into it, which is
 * §14.6's own example verbatim.
 *
 * **The old test asserted the bug.** `envelope.test.ts` required
 * `result.error.message` to *contain* the thrown `'boom'` — so the leak
 * was not merely untested, it was pinned in place by a green assertion.
 * That case is rewritten alongside this file rather than deleted, because
 * the property it was really after (a throw becomes a well-formed
 * envelope, never an uncaught rejection) is still worth having.
 */

const fakeContext = {} as HandlerContext;
const echoSchema: MethodSchema = {
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function dispatchThrowing(thrown: unknown) {
  return dispatchIpcCall(
    'test.throws',
    echoSchema,
    (): never => {
      throw thrown;
    },
    fakeContext,
    true,
    { n: 1 },
  );
}

describe('§14.6: a raw thrown message never reaches the user (AUDIT #16)', () => {
  it('an ENOENT does not appear in what the user is shown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await dispatchThrowing(
      new Error("ENOENT: no such file or directory, open 'C:\\Users\\nikunj\\bureau.db'"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain('ENOENT');
    expect(
      result.error.message,
      "§14.6's own example of a bug: the raw OS string shown to a person",
    ).not.toContain('no such file');
    // And not the user's home directory either — a raw message is a
    // privacy leak as well as an unreadable one.
    expect(result.error.message).not.toContain('nikunj');
  });

  it('the message is the same regardless of what was thrown — it is a fixed sentence, not a template', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await dispatchThrowing(new Error('boom'));
    const b = await dispatchThrowing(new Error('a completely different failure'));
    const c = await dispatchThrowing('not even an Error');
    if (a.ok || b.ok || c.ok) throw new Error('expected all three to fail');
    expect(a.error.message).toBe(b.error.message);
    expect(b.error.message).toBe(c.error.message);
  });

  it('carries a concrete next action, which is the half §14.6 says is mandatory', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await dispatchThrowing(new Error('boom'));
    if (result.ok) return;
    expect(result.error.action).toEqual({ type: 'contact_support' });
    // Whatever it is, it must be a real variant of the union rather than
    // an object that merely looks like one.
    expect(() => IpcErrorActionSchema.parse(result.error.action)).not.toThrow();
  });

  it('logs the raw message rather than discarding it — hidden from the user, not from the developer', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await dispatchThrowing(new Error('ENOENT: the specific thing that broke'));
    const logged = spy.mock.calls.flat().map(String).join(' ');
    expect(logged, 'translating for the user must not mean losing the diagnosis').toContain(
      'ENOENT: the specific thing that broke',
    );
  });

  it('still never throws across IPC — the property the old test was really about', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await dispatchThrowing(new Error('boom'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERNAL_ERROR');
  });

  it('a handler that returns its own ipcError is still passed through untouched', async () => {
    // The translation is for THROWN errors. A handler that chose its own
    // plain-language message and action has already done §14.6's work,
    // and the router replacing it would undo exactly the thing this
    // finding is asking for.
    const chosen = {
      ok: false as const,
      error: { code: 'CONFLICT' as const, message: 'Someone already answered that.' },
    };
    const result = await dispatchIpcCall(
      'test.chose',
      echoSchema,
      () => chosen,
      fakeContext,
      true,
      { n: 1 },
    );
    expect(result).toEqual(chosen);
  });

  it('a successful call is untouched', async () => {
    const result = await dispatchIpcCall(
      'test.ok',
      echoSchema,
      () => ipcOk({ n: 2 }),
      fakeContext,
      true,
      { n: 1 },
    );
    expect(result).toEqual({ ok: true, data: { n: 2 } });
  });
});
