/**
 * Puts a freshly spawned engine process into Bureau's Job Object (M11 row
 * S1-9; pre-M11 §F, P-10).
 *
 * `containProcess()` had no production caller. Engine children still died
 * with Bureau, but only because libuv puts every non-detached child into
 * its own kill-on-close job — which covers nothing an engine starts
 * detached. Containing the engine process itself makes Bureau's own job
 * the guarantee, and a job's children inherit it.
 *
 * **Injected, never imported by the adapters.** The Job Object module is a
 * native addon built for Electron's ABI; importing it from an adapter would
 * break every plain-Node test that constructs one. Production passes the
 * real `containProcess` in (main → startDirector → the adapter factory).
 * An adapter built without one contains nothing, which is what tests that
 * do not care about containment get.
 */
export type ContainProcess = (pid: number) => void;

/** What the user reads when a turn is refused because containment failed. */
export const ENGINE_NOT_CONTAINED_MESSAGE =
  "Bureau stopped the engine because it couldn't put it under Bureau's own process control, " +
  'which is what makes sure it stops when Bureau does. Try again; if it keeps happening, restart Bureau.';

/**
 * Contains `pid`. Returns null on success (or when there is nothing to do),
 * and the message to show when containment failed — in which case the
 * caller must kill the process at once (invariant #6: an engine Bureau
 * cannot guarantee to stop must not run).
 */
export function containEngineChild(
  pid: number | undefined,
  containProcess: ContainProcess | undefined,
): string | null {
  if (containProcess === undefined || pid === undefined) return null;
  try {
    containProcess(pid);
    return null;
  } catch (err) {
    console.error(`[engine] could not contain process ${pid}:`, err);
    return ENGINE_NOT_CONTAINED_MESSAGE;
  }
}
