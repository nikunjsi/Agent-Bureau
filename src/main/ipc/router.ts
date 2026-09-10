import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import type Database from 'better-sqlite3';
import { allIpcChannels, type IpcNamespace } from '../../shared/ipc/methodList';
import { IPC_SCHEMAS } from '../../shared/ipc/schemas';
import { ipcError, ipcOk, isIpcResultShape, type IpcResult } from '../../shared/ipc/envelope';
import { isKnownSender } from '../windowRegistry';
import type { ActivityLog } from '../db/activityLog';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import type { PolicyHoldRegistry } from '../controlChannel/policyHoldRegistry';
import type { ChatStreamRegistry } from '../chat/chatStream';
import type { ChatBroadcaster } from '../chat/chatBroadcaster';
import type { DbPaths } from '../db/paths';
import type { PricingTable } from '../../shared/models/pricing';
import { getHandler, type Handler, type HandlerContext } from './handlers';

export interface MethodSchema {
  readonly input: z.ZodTypeAny;
  readonly output: z.ZodTypeAny;
}

/**
 * `IPC_SCHEMAS` and `IPC_METHODS` (methodList.ts) are built from the same
 * namespace/method names by construction — `checkIpcSurface.mjs` is what
 * actually guarantees that at commit time, not this assertion. Isolated to
 * this one lookup function rather than scattered through the router, and
 * only ever handed a `{namespace, method}` pair that `allIpcChannels()`
 * itself produced.
 */
export function getMethodSchema(namespace: IpcNamespace, method: string): MethodSchema {
  const namespaceSchemas = IPC_SCHEMAS[namespace] as unknown as Record<string, MethodSchema>;
  const schema = namespaceSchemas[method];
  if (!schema) {
    throw new Error(
      `No schema registered for ${namespace}.${method} — methodList.ts and schemas/index.ts have drifted`,
    );
  }
  return schema;
}

/**
 * The actual per-call logic §17.2/§4.2 describes — pulled out of the
 * `ipcMain.handle` closure so it's unit-testable without a real Electron
 * IPC round trip (same reasoning as M0's `pathGuard.ts` split out of
 * `protocol.ts`). `isSenderKnown` is injected rather than importing
 * `windowRegistry` directly, for the same testability reason.
 *
 *   1. Rejects a sender that isn't a window Bureau itself created
 *      (`UNKNOWN_SENDER`).
 *   2. Validates input against the method's Zod schema — dropped and
 *      logged, never coerced, on failure (`VALIDATION_FAILED`).
 *   3. Calls the real handler (or the `NOT_IMPLEMENTED` stub) inside a
 *      try/catch that turns *any* thrown error into `INTERNAL_ERROR`.
 *      **The channel never throws — this is the whole point of §17.2.**
 *
 * `output.parse()` runs on the way out too — a handler that returns a
 * shape its own schema wouldn't accept is a bug caught here, in
 * development, not shipped to a user as silently-wrong data.
 */
export async function dispatchIpcCall(
  channel: string,
  schema: MethodSchema,
  handler: Handler,
  context: HandlerContext,
  isSenderKnown: boolean,
  rawInput: unknown,
): Promise<IpcResult<unknown>> {
  if (!isSenderKnown) {
    console.error(`[ipc] rejected ${channel} from an unrecognised sender`);
    return ipcError('UNKNOWN_SENDER', 'This request did not come from a recognised Bureau window.');
  }

  const parsedInput = schema.input.safeParse(rawInput);
  if (!parsedInput.success) {
    console.error(`[ipc] rejected ${channel}: malformed payload`, parsedInput.error.issues);
    return ipcError('VALIDATION_FAILED', 'That request was malformed and was not processed.');
  }

  try {
    const result = await handler(parsedInput.data, context);
    // Every handler returns a *full* IpcResult itself (ipcOk(...) for
    // success, ipcError(...)/ipcNotImplemented(...) for a deliberate
    // failure like a stub) — not a bare data value. An error the handler
    // chose is passed through as-is; only the success payload gets
    // validated against the method's own output schema, and re-wrapped
    // with the now-validated data (never the handler's original object
    // reference, so a handler can't accidentally leak an unvalidated
    // extra field).
    if (!isIpcResultShape(result)) {
      throw new Error(`Handler for ${channel} did not return an IpcResult`);
    }
    if (!result.ok) return result;
    const parsedOutput = schema.output.parse(result.data);
    return ipcOk(parsedOutput);
  } catch (err) {
    // AUDIT M0–M2 #16 / §14.6: "'Error: ENOENT' reaching the user is a
    // bug", and CLAUDE.md's version — *do not show raw engine output to
    // the user by default. Translate.*
    //
    // This used to interpolate `err.message` into the user-facing string,
    // so a `shell.openPath` failure, a SQLite error and a stack-carrying
    // TypeError were all shown verbatim to a person who cannot act on any
    // of them — and the raw text can carry a filesystem path, which makes
    // it a privacy leak as well as an unreadable one.
    //
    // **Hidden from the user, not from the developer.** The raw error
    // still goes to the console in full, which is where a diagnosis
    // belongs; what changes is that it stops being presented as an
    // explanation to someone who did nothing wrong.
    //
    // A fixed sentence rather than a template, deliberately: a message
    // that varies with the internals is a template with a leak waiting to
    // be reintroduced, and `errorActions.test.ts` pins it by asserting
    // three different throws produce the identical message.
    console.error(`[ipc] ${channel} threw:`, err);
    return ipcError('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE, { type: 'contact_support' });
  }
}

/**
 * §14.6's three parts for the one error the user can never have caused:
 * what happened ("something inside Bureau failed"), why (it is a bug, not
 * their input), and a next action (`contact_support`, whose wording and
 * placement are the renderer's to choose — see `ErrorNotice`).
 *
 * Exported so tests assert against the real constant rather than a copy
 * of the sentence.
 */
export const INTERNAL_ERROR_MESSAGE =
  'Something inside Bureau failed while handling that. This is a bug in Bureau, not ' +
  'something you did — the details have been written to the log.';

/** Registers one `ipcMain.handle` per §17.1 method — the thin Electron
 * wiring around `dispatchIpcCall`. */
export function registerIpcRouter(
  db: Database.Database,
  activityLog: ActivityLog,
  dbPaths: DbPaths,
  pricing: PricingTable,
  packEnvironment: { baseDir: string; bundledPacksDir: string; appVersion: string },
  supervisorRegistry?: SupervisorRegistry,
  policyHoldRegistry?: PolicyHoldRegistry,
  chatStreams?: ChatStreamRegistry,
  chatBroadcaster?: ChatBroadcaster,
): void {
  const context: HandlerContext = {
    db,
    activityLog,
    dbPaths,
    pricing,
    ...packEnvironment,
    supervisorRegistry,
    policyHoldRegistry,
    chatStreams,
    chatBroadcaster,
  };

  for (const { namespace, method, channel } of allIpcChannels()) {
    const schema = getMethodSchema(namespace, method);
    const handler = getHandler(namespace, method);

    ipcMain.handle(
      channel,
      async (event: IpcMainInvokeEvent, rawInput: unknown): Promise<IpcResult<unknown>> => {
        return dispatchIpcCall(
          channel,
          schema,
          handler,
          context,
          isKnownSender(event.sender),
          rawInput,
        );
      },
    );
  }
}
