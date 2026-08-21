import { StateDeltaSchema } from '../../shared/ipc/schemas/events';
import { useBureauStore } from './store/bureauStore';

/**
 * Subscribes once to `on.stateDelta` and pipes validated deltas into the
 * store. The preload is a thin pass-through with no Zod (§17.3) — this is
 * where "every IPC payload... is validated" (§4.2) actually happens for
 * *pushed* events, the renderer-side equivalent of what the main-side
 * router does for `invoke` calls. Only the delta's own envelope shape
 * (`kind`/`seq`/`slice`) is validated here, not each slice's deep model
 * shape — main is the same trusted process that already validated those
 * via M1's repositories before ever building the snapshot.
 *
 * Returns the unsubscribe function `window.bureau.on.stateDelta` gives
 * back, for symmetry / so a future multi-window scenario can tear this
 * down per-window.
 */
export function wireIpcBridge(): () => void {
  return window.bureau.on.stateDelta((payload) => {
    const parsed = StateDeltaSchema.safeParse(payload);
    if (!parsed.success) {
      console.error('[stateDelta] dropped a malformed delta', parsed.error.issues);
      return;
    }
    useBureauStore.getState().applyDelta(parsed.data);
  });
}
