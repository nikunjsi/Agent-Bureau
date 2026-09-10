import { shell } from 'electron';
import { ipcError, ipcOk, type IpcResult } from '../../../shared/ipc/envelope';

/**
 * AUDIT M0–M2 #16 — the three `shell.openPath` call sites, which each did:
 *
 *     const err = await shell.openPath(target);
 *     if (err) throw new Error(err);
 *
 * `shell.openPath` **resolves** with an OS error string rather than
 * rejecting, so this wrapped that string in an `Error` and threw it
 * through the router and into the user's face. §14.6 names this case in as
 * many words: *"'Error: ENOENT' reaching the user is a bug."*
 *
 * One function rather than three copies of the sentence (standing rule 6):
 * "what Bureau says when it cannot open something for you" is a single
 * decision, and `system.openPath`, `system.openDataFolder` and
 * `activity.openRawLog` are three callers of it.
 *
 * It **returns** an envelope rather than throwing, because the router's
 * catch-all is deliberately a fixed sentence that says nothing about what
 * was being attempted — right for an unforeseen failure, and needlessly
 * vague here, where we know exactly what the user asked for and what to
 * tell them instead.
 *
 * **No `action`, deliberately.** §14.6 asks for a concrete next action, "a
 * button where possible", and here it is not possible: every button Bureau
 * could offer would call the same `shell.openPath` and fail the same way.
 * What the user can actually do is open it themselves, so the path is in
 * the sentence — Bureau's own path, which is information, not the OS error
 * string, which is the leak. A button that re-fails is worse than none.
 */
export async function openInShell(
  target: string,
  describeTarget: string,
): Promise<IpcResult<{ ok: true }>> {
  const failure = await shell.openPath(target);
  if (failure !== '') {
    // The raw string is a diagnosis, so it goes where diagnoses go — the
    // log, in full, never the envelope.
    console.error(`[ipc] shell.openPath refused ${target}:`, failure);
    return ipcError(
      'INTERNAL_ERROR',
      `Bureau could not open ${describeTarget}. You can still get to it yourself at ${target}.`,
    );
  }
  return ipcOk({ ok: true as const });
}
