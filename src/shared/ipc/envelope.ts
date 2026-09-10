import { z } from 'zod';

/**
 * §17.2: "All mutations go through `invoke` and return a discriminated
 * result... Never throw across IPC." This is the one shape every handler
 * in `src/main/ipc/router.ts` returns, with no exceptions — a handler
 * that throws internally is caught by the router and turned into an
 * `INTERNAL_ERROR` envelope, never an uncaught rejection crossing the
 * bridge (see tests/unit/ipc/envelope.test.ts).
 *
 * A **closed** set (M2 audit prompt: "not invented per handler"). Adding a
 * code is a deliberate, reviewable change to this one file, not a string
 * some handler happens to type.
 */
export const IpcErrorCodeSchema = z.enum([
  /** Zod rejected the input. Never coerced — §4.2. */
  'VALIDATION_FAILED',
  /** `event.senderFrame` isn't a window Bureau itself created. */
  'UNKNOWN_SENDER',
  /** A well-formed request for something that doesn't exist (by id). */
  'NOT_FOUND',
  /** A real §17.1 method that exists but has no behavior behind it yet —
   * M2 builds the transport, not the feature. Never returned for a method
   * this milestone itself is responsible for implementing for real. */
  'NOT_IMPLEMENTED',
  /** §17.2: "rate-limits where abuse is possible." */
  'RATE_LIMITED',
  /**
   * The request was well formed and the thing exists, but its state moved
   * on. M8 introduces the first real instance: a checkpoint has exactly two
   * legitimate resolvers — the user answering, and a timeout applying the
   * safe default — and `recordCheckpointAnswer`'s compare-and-swap makes
   * the loser a no-op. The user who lost that race needs to be told their
   * answer did not land, which is neither a validation failure (their input
   * was fine) nor a missing row (it is right there, answered).
   */
  'CONFLICT',
  /** The handler threw. The router's catch-all — see router.ts. */
  'INTERNAL_ERROR',
]);
export type IpcErrorCode = z.infer<typeof IpcErrorCodeSchema>;

/**
 * §14.6: "Every error surfaced to the user MUST have: what happened in
 * plain language, why, and a concrete next action (a button where
 * possible)." A bare string here would leave `action` "vestigial" (the
 * audit prompt's own word for what to avoid) — this is a discriminated
 * union so the renderer can render a real button per variant instead of
 * parsing intent out of prose.
 */
export const IpcErrorActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('retry') }),
  z.object({ type: z.literal('open_settings'), group: z.string().optional() }),
  z.object({ type: z.literal('open_url'), url: z.string().url() }),
  z.object({ type: z.literal('restart') }),
  z.object({ type: z.literal('contact_support') }),
]);
export type IpcErrorAction = z.infer<typeof IpcErrorActionSchema>;

export const IpcErrorSchema = z.object({
  code: IpcErrorCodeSchema,
  /** Plain language, shown directly to the user — never "Error: ENOENT"
   * (§14.6's explicit example of what NOT to do). */
  message: z.string().min(1),
  action: IpcErrorActionSchema.optional(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

/** Builds the discriminated `{ok:true,data}|{ok:false,error}` schema for
 * one method's specific output type. Every method schema in
 * `src/shared/ipc/schemas/` wraps its output with this. */
export function ipcResultSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: dataSchema }),
    z.object({ ok: z.literal(false), error: IpcErrorSchema }),
  ]);
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export function ipcOk<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function ipcError(
  code: IpcErrorCode,
  message: string,
  action?: IpcErrorAction,
): IpcResult<never> {
  return { ok: false, error: action === undefined ? { code, message } : { code, message, action } };
}

/** A cheap structural check, not a full Zod parse — used by the router to
 * confirm a handler actually returned `ipcOk(...)`/`ipcError(...)` (every
 * handler in `src/main/ipc/handlers/` does) rather than a bare data value,
 * before it trusts `result.ok`/`result.data`. */
export function isIpcResultShape(value: unknown): value is IpcResult<unknown> {
  return (
    typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean'
  );
}

/**
 * The one, single place `NOT_IMPLEMENTED` gets constructed, so its message
 * and action are consistent everywhere a stub handler uses it.
 *
 * **It carries no `action`, and that is the answer rather than an
 * omission** (AUDIT M0–M2 #16, which gave `NOT_FOUND` and `CONFLICT`
 * theirs). §14.6 asks for "a concrete next action (a button where
 * possible)", and for a feature that does not exist yet there is genuinely
 * nothing the user can do: retrying fails identically, no setting enables
 * it, and restarting changes nothing. Every variant of the union would be
 * a button that lies about being useful.
 *
 * `ErrorNotice` renders the message alone when there is no action, so the
 * honest outcome — plain language, no false promise — is what ships.
 */
export function ipcNotImplemented(owningMilestone: string): IpcResult<never> {
  return ipcError(
    'NOT_IMPLEMENTED',
    `This isn't built yet — it belongs to ${owningMilestone}, not the current milestone.`,
  );
}
