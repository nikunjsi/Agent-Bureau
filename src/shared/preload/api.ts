import type { z } from 'zod';
import type { IPC_SCHEMAS } from '../ipc/schemas';
import type { IPC_EVENT_SCHEMAS } from '../ipc/schemas/events';
import type { IpcResult } from '../ipc/envelope';

type AnyMethodSchema = { readonly input: z.ZodTypeAny; readonly output: z.ZodTypeAny };

type MethodsOf<NS extends Record<string, AnyMethodSchema>> = {
  [M in keyof NS]: (input: z.infer<NS[M]['input']>) => Promise<IpcResult<z.infer<NS[M]['output']>>>;
};

type EventSubscriptions = {
  [E in keyof typeof IPC_EVENT_SCHEMAS]: (
    callback: (payload: z.infer<(typeof IPC_EVENT_SCHEMAS)[E]>) => void,
  ) => () => void;
};

/**
 * The full surface exposed on `window.bureau` by the preload script
 * (src/preload/index.ts) — **derived** from `src/shared/ipc/schemas/`
 * rather than hand-enumerated, so this type can never quietly drift from
 * the schemas that are the actual contract (§17.1: "the schema is the
 * contract"). `scripts/checkIpcSurface.mjs` is what keeps the *schemas*
 * themselves in sync with docs/BUILD-SPEC.md §17.1; this file inherits
 * that guarantee for free.
 */
export type BureauApi = {
  [N in keyof typeof IPC_SCHEMAS]: MethodsOf<(typeof IPC_SCHEMAS)[N]>;
} & {
  on: EventSubscriptions;
};
