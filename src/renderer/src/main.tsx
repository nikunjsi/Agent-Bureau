import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { wireIpcBridge } from './ipcBridge';
import './theme.css';

/**
 * **Subscribed here, at module scope, before React mounts — deliberately.**
 *
 * `wireStateDeltaOnLoad` sends this window's only unprompted snapshot on
 * `did-finish-load`, and Electron does not queue an IPC message for a
 * channel with no listener: if the subscription is not up by then, the
 * snapshot is gone, the store never hydrates, and **nothing re-requests
 * it** — the window sits on "Starting Bureau…" until someone reloads it.
 *
 * It used to be a `useEffect` in `WindowShell`, which is after mount, after
 * paint, and — under `StrictMode`'s deliberate double-invocation —
 * momentarily *unsubscribed* while React tears the first effect down and
 * runs it again. All of that is normally comfortably before the load event
 * completes, which is why it has worked; none of it is guaranteed to be,
 * and a slow machine is exactly where it would not be. Moved here after a
 * `stateDeltaReconnect` failure that looked like this and could not be
 * reproduced — recorded in PROJECT-CHECKLIST's Known Issues as
 * unreproduced, with this narrowing of a real race as what came out of
 * looking for it.
 *
 * There is no teardown because there is nothing to tear down: the
 * subscription lives exactly as long as the window does.
 */
wireIpcBridge();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('#root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
