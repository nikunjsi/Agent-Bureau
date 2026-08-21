import { contextBridge, ipcRenderer } from 'electron';
import { allIpcChannels, IPC_EVENTS } from '../shared/ipc/methodList';
import type { BureauApi } from '../shared/preload/api';

/**
 * The only surface the renderer gets. `contextIsolation`/`sandbox` are on,
 * so this is genuinely the entire boundary (§4.2) — S13 proves nothing
 * else leaks through.
 *
 * §17.3/M2 step 3: "a thin pass-through... No logic." Built from
 * `methodList.ts` (the same canonical list `checkIpcSurface.mjs` diffs
 * against §17.1) rather than ~109 hand-written, identical-shaped
 * `ipcRenderer.invoke` wrappers — there is no validation or business
 * logic to review per method, so the repetition would cost real
 * maintenance risk (a typo'd channel string, a forgotten new method) for
 * zero auditability benefit. All Zod validation happens on the main side
 * (src/main/ipc/router.ts) — this file imports no Zod at all, so it never
 * needs to be told about the sandbox's "no npm packages at runtime" rule.
 */
type NamespaceMethods = Record<string, (input: unknown) => Promise<unknown>>;
const namespaces: Record<string, NamespaceMethods> = {};
for (const { namespace, method, channel } of allIpcChannels()) {
  namespaces[namespace] ??= {};
  namespaces[namespace][method] = (input: unknown) => ipcRenderer.invoke(channel, input);
}

type Unsubscribe = () => void;
const on: Record<string, (callback: (payload: unknown) => void) => Unsubscribe> = {};
for (const eventName of IPC_EVENTS) {
  on[eventName] = (callback: (payload: unknown) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on(eventName, listener);
    return () => ipcRenderer.removeListener(eventName, listener);
  };
}

// The loop above proves at runtime (via allIpcChannels()/IPC_EVENTS, the
// same lists checkIpcSurface.mjs verifies against §17.1) that every
// namespace/method/event BureauApi's derived type expects actually gets
// wired — this cast is the one place that correspondence is asserted
// rather than independently re-derived by the type checker.
const bureauApi = { ...namespaces, on } as unknown as BureauApi;

contextBridge.exposeInMainWorld('bureau', bureauApi);
