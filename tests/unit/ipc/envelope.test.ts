import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dispatchIpcCall, type MethodSchema } from '../../../src/main/ipc/router';
import { ipcOk, ipcNotImplemented } from '../../../src/shared/ipc/envelope';
import type { HandlerContext } from '../../../src/main/ipc/handlers';

// A HandlerContext none of these handlers actually touch — every case
// here is about dispatchIpcCall's own sender/validation/error logic, not
// a real handler's behavior.
const fakeContext = {} as HandlerContext;

const echoSchema: MethodSchema = {
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
};

describe('dispatchIpcCall (§17.2: "never throw across IPC") — unit', () => {
  it('a handler that throws still produces a well-formed INTERNAL_ERROR envelope, not an uncaught rejection', async () => {
    const throwingHandler = (): never => {
      throw new Error('boom');
    };
    const result = await dispatchIpcCall(
      'test.throws',
      echoSchema,
      throwingHandler,
      fakeContext,
      true,
      { n: 1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL_ERROR');
      // AUDIT M0–M2 #16. This line used to be
      // `expect(result.error.message).toContain('boom')` — asserting that
      // the raw thrown message reached the user, which is §14.6's own
      // example of a bug ("'Error: ENOENT' reaching the user"). The leak
      // was not merely untested; it was **pinned in place by a green
      // assertion**, which is why reading the suite could not find it.
      //
      // The property this case was really about — a throw becomes a
      // well-formed envelope rather than an uncaught rejection crossing
      // the bridge — is what it now asserts. The translation itself has
      // its own file: `errorActions.test.ts`.
      expect(result.error.message).not.toContain('boom');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('a handler that throws a non-Error value still produces a well-formed envelope', async () => {
    const throwingHandler = (): never => {
      // Deliberately testing the non-Error path.
      throw 'a plain string, not an Error';
    };
    const result = await dispatchIpcCall(
      'test.throws2',
      echoSchema,
      throwingHandler,
      fakeContext,
      true,
      { n: 1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERNAL_ERROR');
  });

  it('rejects an unrecognised sender before the handler ever runs', async () => {
    let called = false;
    const handler = (): unknown => {
      called = true;
      return ipcOk({ n: 1 });
    };
    const result = await dispatchIpcCall('test.method', echoSchema, handler, fakeContext, false, {
      n: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_SENDER');
    expect(called).toBe(false);
  });

  it('rejects malformed input before the handler ever runs — dropped, never coerced', async () => {
    let called = false;
    const handler = (): unknown => {
      called = true;
      return ipcOk({ n: 1 });
    };
    const result = await dispatchIpcCall('test.method', echoSchema, handler, fakeContext, true, {
      n: 'not a number',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(called).toBe(false);
  });

  it('a well-formed call from a known sender succeeds', async () => {
    const handler = (input: unknown): unknown => ipcOk(input);
    const result = await dispatchIpcCall('test.method', echoSchema, handler, fakeContext, true, {
      n: 42,
    });
    expect(result).toEqual({ ok: true, data: { n: 42 } });
  });

  it("a handler's own success data that does not match its output schema is caught as INTERNAL_ERROR, not shipped", async () => {
    const handler = (): unknown => ipcOk({ n: 'wrong type' });
    const result = await dispatchIpcCall('test.method', echoSchema, handler, fakeContext, true, {
      n: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERNAL_ERROR');
  });

  // This is the regression test for a real bug found while smoke-testing
  // the packaged app: every real handler constructs its own full
  // envelope (ipcOk(...) for success, ipcError(...)/ipcNotImplemented(...)
  // for a deliberate failure like a stub) — dispatchIpcCall used to
  // re-wrap whatever the handler returned in *another* ipcOk(...), so a
  // stub's ipcNotImplemented() became {ok:true, data:{ok:false,...}}
  // instead of passing through, and every successful handler's own
  // {ok:true,data} became doubly nested the same way. Every method that
  // touched a real repository or returned a stub was broken by this in
  // the actual packaged app; no unit test had caught it because this
  // exact path was never exercised with a handler shaped like the real
  // ones.
  it("passes a handler's own ipcError()/ipcNotImplemented() result through unchanged, not wrapped in a second envelope", async () => {
    const stubHandler = (): unknown => ipcNotImplemented('M11');
    const result = await dispatchIpcCall('test.stub', echoSchema, stubHandler, fakeContext, true, {
      n: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_IMPLEMENTED');
      // The bug this guards against would have produced {ok:true, data:
      // {ok:false, error:{...}}} instead — assert the shape is genuinely
      // flat, not just that .ok is falsy somewhere in it.
      expect(result).not.toHaveProperty('data');
    }
  });

  it('a handler that returns a bare, unwrapped value (not ipcOk()/ipcError()) is treated as a bug, not shipped as data', async () => {
    const misbehavingHandler = (): unknown => ({ n: 1 }); // forgot to call ipcOk()
    const result = await dispatchIpcCall(
      'test.method',
      echoSchema,
      misbehavingHandler,
      fakeContext,
      true,
      { n: 1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERNAL_ERROR');
  });
});
