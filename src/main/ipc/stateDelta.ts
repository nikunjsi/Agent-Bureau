import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getAllSettings } from '../db/repositories/settings';
import { getCompanyById } from '../db/repositories/companies';
import { getProjectById } from '../db/repositories/projects';
import { getTaskById } from '../db/repositories/tasks';
import { getEmployeeById } from '../db/repositories/employees';
import { getCheckpointById } from '../db/repositories/checkpoints';
import type { StateDelta, StateDeltaSliceName } from '../../shared/ipc/schemas/events';
import { redactDeep } from '../secrets/redactor';

/**
 * §17.2: "The renderer holds no authoritative state. It hydrates from
 * `stateDelta` and re-hydrates fully on reconnect." One counter, shared
 * across every window (a `full` delta always restarts a window's own
 * `lastAppliedSeq` tracking on the renderer side, so sharing the counter
 * across windows is safe — see schemas/events.ts's doc comment for the
 * full kind/seq semantics).
 */
let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

function listIds(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[]).map((row) => row.id);
}

/** Exported for M6 session 3's S4 (`canarySecretNeverLeaks.test.ts`) —
 * a pure function of `db`, no `BrowserWindow`/Electron dependency of its
 * own (only `wireStateDeltaOnLoad`/`pushPatch` below need a real window),
 * so it can be called and its output redacted exactly the way the real
 * `wireStateDeltaOnLoad` call below does, without needing a real window
 * to observe the IPC send. */
export function buildFullSnapshot(db: Database.Database): StateDelta {
  const companyRow = db.prepare('SELECT id FROM companies LIMIT 1').get() as { id: string } | undefined;

  const slices: Record<StateDeltaSliceName, unknown> = {
    settings: getAllSettings(db),
    company: companyRow ? getCompanyById(db, companyRow.id) : null,
    projects: listIds(db, 'projects').map((id) => getProjectById(db, id)).filter((p) => p !== null),
    tasks: listIds(db, 'tasks').map((id) => getTaskById(db, id)).filter((t) => t !== null),
    employees: listIds(db, 'employees').map((id) => getEmployeeById(db, id)).filter((e) => e !== null),
    checkpoints: (db.prepare("SELECT id FROM checkpoints WHERE status = 'pending'").all() as { id: string }[])
      .map((row) => getCheckpointById(db, row.id))
      .filter((c) => c !== null),
  };

  return { kind: 'full', seq: nextSeq(), slices };
}

/**
 * Pushes a full snapshot to one window on `did-finish-load` — fires on the
 * window's initial load *and* on any reload/crash-recovery, which is what
 * makes "re-hydrates fully on reconnect" (§17.2) true without needing an
 * explicit renderer-initiated "give me state" request (§17.1 doesn't name
 * one, and Electron gives us this signal for free — see the M2 plan).
 *
 * §11.4 choke point 4/6: this pushes real `checkpoints`/`employees`/
 * `tasks` rows straight to the renderer — a distinct outbound path from
 * `activityLog`'s own events, not already covered by redacting those
 * (a checkpoint's `context`, a task's `result_summary`, or an employee's
 * `status_detail` are all agent-influenced free text that never passes
 * through `logEvent()` at all). Deep-redacted here, once, right before
 * it leaves the process — the one real producer today; a future
 * incremental-delta producer (this file's own comment below already
 * flags it as a later milestone's job) must route through the same call
 * when it exists, not bypass it.
 */
export function wireStateDeltaOnLoad(win: BrowserWindow, db: Database.Database): void {
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('stateDelta', redactDeep(buildFullSnapshot(db)));
  });
}

/** For a later milestone's real producer of incremental changes — not
 * called by anything in M2 itself, since M2 builds no feature that
 * changes this state on its own (settings.set is the one exception, and
 * even that doesn't need a live push: the setter's own IPC response is
 * enough for the one window that made the change). Exported now so the
 * shape is proven by stateDeltaReconnect.test.ts rather than invented
 * fresh whenever the first real producer needs it. */
export function pushPatch(win: BrowserWindow, slice: StateDeltaSliceName, value: unknown): void {
  if (win.isDestroyed()) return;
  // §11.4 choke point 4/6, same reasoning as buildFullSnapshot's own
  // caller above — no real caller exists yet, but this is a real,
  // exported function a future milestone will wire up, not a stub;
  // redacting here means that future caller doesn't have to remember to.
  const delta: StateDelta = { kind: 'patch', seq: nextSeq(), slice, value: redactDeep(value) };
  win.webContents.send('stateDelta', delta);
}
