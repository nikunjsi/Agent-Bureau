import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getAllSettings } from '../db/repositories/settings';
import { getCompanyById } from '../db/repositories/companies';
import { getProjectById } from '../db/repositories/projects';
import { getTaskById } from '../db/repositories/tasks';
import { getEmployeeById } from '../db/repositories/employees';
import { listPendingCheckpoints } from '../db/repositories/checkpoints';
import type { StateDelta, StateDeltaSliceName } from '../../shared/ipc/schemas/events';
import { redactDeep } from '../secrets/redactor';
import { allKnownWindows } from '../windowRegistry';
import { hasChannels, nextSeqFor, startWindowChannels } from './windowChannelSeq';

/**
 * §17.2: "The renderer holds no authoritative state. It hydrates from
 * `stateDelta` and re-hydrates fully on reconnect."
 *
 * **Sequence numbers are per window, not global** (M9). They were global,
 * on the strength of a comment claiming that was safe because a `full`
 * delta resets each renderer's tracking — see `windowChannelSeq.ts` for the
 * two-window trace showing it is not, and why M9 is the milestone where it
 * stops being theoretical.
 */

function listIds(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[]).map((row) => row.id);
}

/** Exported for M6 session 3's S4 (`canarySecretNeverLeaks.test.ts`) —
 * a pure function of `db`, no `BrowserWindow`/Electron dependency of its
 * own (only `wireStateDeltaOnLoad`/`pushPatch` below need a real window),
 * so it can be called and its output redacted exactly the way the real
 * `wireStateDeltaOnLoad` call below does, without needing a real window
 * to observe the IPC send.
 *
 * `seq` is a parameter rather than something this function allocates: it
 * belongs to the window being sent to, and this function does not know
 * which window that is. */
export function buildFullSnapshot(db: Database.Database, seq = 1): StateDelta {
  const companyRow = db.prepare('SELECT id FROM companies LIMIT 1').get() as
    { id: string } | undefined;

  const slices: Record<StateDeltaSliceName, unknown> = {
    settings: getAllSettings(db),
    company: companyRow ? getCompanyById(db, companyRow.id) : null,
    projects: listIds(db, 'projects')
      .map((id) => getProjectById(db, id))
      .filter((p) => p !== null),
    tasks: listIds(db, 'tasks')
      .map((id) => getTaskById(db, id))
      .filter((t) => t !== null),
    employees: listIds(db, 'employees')
      .map((id) => getEmployeeById(db, id))
      .filter((e) => e !== null),
    // §9.4: "all reflecting one piece of state". This used to be its own
    // inline `WHERE status = 'pending'` query — a second definition of
    // "pending" alongside `listPendingCheckpoints`, which is what
    // `checkpoints.listPending` and `CheckpointSurfacer` both call. Two
    // queries that agree today are free to drift; one function is not
    // (standing rule 6). M9's chat card renders from this slice, so the
    // two had to become one before the card could claim to be surface 1.
    checkpoints: listPendingCheckpoints(db),
  };

  return { kind: 'full', seq, slices };
}

/**
 * Pushes a full snapshot to one window on `did-finish-load` — fires on the
 * window's initial load *and* on any reload/crash-recovery, which is what
 * makes "re-hydrates fully on reconnect" (§17.2) true without needing an
 * explicit renderer-initiated "give me state" request.
 *
 * The load is also where this window's push sequences begin: a reload
 * re-creates the renderer's own state, so both sides restart together and
 * the first snapshot after any load is always seq 1.
 *
 * §11.4 choke point 4/6: this pushes real `checkpoints`/`employees`/
 * `tasks` rows straight to the renderer — a distinct outbound path from
 * `activityLog`'s own events. Deep-redacted here, once, right before it
 * leaves the process.
 */
export function wireStateDeltaOnLoad(win: BrowserWindow, db: Database.Database): void {
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    startWindowChannels(win);
    const seq = nextSeqFor(win, 'stateDelta');
    win.webContents.send('stateDelta', redactDeep(buildFullSnapshot(db, seq)));
  });
}

/** One window, one slice. The primitive `broadcastPatch` is built from;
 * also called directly when a caller genuinely has one window in hand. */
export function pushPatch(win: BrowserWindow, slice: StateDeltaSliceName, value: unknown): void {
  if (win.isDestroyed()) return;
  // A window addressed explicitly by a caller that holds it gets its
  // sequence started here if it has none. The broadcast path deliberately
  // does NOT do this — see below.
  if (!hasChannels(win)) startWindowChannels(win);
  // §11.4 choke point 4/6, same reasoning as buildFullSnapshot's caller
  // above — redacting here means no future caller has to remember to.
  const delta: StateDelta = {
    kind: 'patch',
    seq: nextSeqFor(win, 'stateDelta'),
    slice,
    value: redactDeep(value),
  };
  win.webContents.send('stateDelta', delta);
}

/**
 * Every open window, each with its own sequence number.
 *
 * **Windows that have not finished loading are skipped**, not given a
 * patch with an invented sequence: such a window has not been sent a `full`
 * snapshot yet, so it has nothing to apply a patch on top of, and one is
 * coming on `did-finish-load` regardless. `bureauStore.applyDelta` would
 * drop it anyway; skipping means it is not counted as a gap.
 *
 * `windows` is injectable for the same reason `dispatchIpcCall` takes
 * `isSenderKnown` rather than importing the registry: a real
 * `BrowserWindow` needs an Electron runtime the vitest suites never have,
 * and the loop — which is where the skip lives — is the part worth testing.
 */
export function broadcastPatch(
  slice: StateDeltaSliceName,
  value: unknown,
  windows: BrowserWindow[] = allKnownWindows(),
): void {
  for (const win of windows) {
    if (win.isDestroyed() || !hasChannels(win)) continue;
    pushPatch(win, slice, value);
  }
}
