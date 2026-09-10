import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { listPendingCheckpoints } from '../db/repositories/checkpoints';
import { listEmployees } from '../db/repositories/employees';
import { getAllSettings } from '../db/repositories/settings';
import { buildFullSnapshot } from './stateDelta';
import { broadcastPatch } from './stateDelta';

/**
 * Keeps open windows current between loads.
 *
 * Before M9 the renderer hydrated once, on `did-finish-load`, and never
 * heard about a change again — `pushPatch` existed and had no callers. A
 * checkpoint card that appears in chat when it is raised, and leaves when
 * it is answered, is the first thing that needs otherwise.
 *
 * ## Why it subscribes to events rather than being called at each site
 *
 * "Which pending checkpoints are there" changes in five places: raised (two
 * producers), answered, expired, auto-resolved, cancelled. Calling a push
 * from each is five places that must each remember, and the sixth — added
 * next milestone — is the one that will not. Every one of them already
 * emits exactly one `checkpoint.*` activity event, because invariant #3
 * requires it, so subscribing to that is one subscription that cannot fall
 * behind the code.
 *
 * ## What it does not do
 *
 * It does not decide anything. It re-reads `listPendingCheckpoints` and
 * `listEmployees` — the same functions `checkpoints.listPending`,
 * `CheckpointSurfacer`, `employees.list` and the full snapshot all call —
 * and sends what it finds. §9.4's "all reflecting one piece of state" is a
 * property of sharing that call; a broadcaster that maintained its own idea
 * of the pending set would be the fifth surface disagreeing with the other
 * four.
 *
 * ## Why `employees` joined it (M9 session 2)
 *
 * The same argument, found the same way — by something visibly not
 * happening. `/pause` stops an employee and the Resume banner above the
 * composer renders from the `employees` slice, so a resume that changed the
 * row but never reached the window left the banner sitting there: the undo
 * worked and looked broken, which for an undo is barely better than not
 * working. Every employee state change already emits exactly one
 * `employee.*` event (invariant #3, and `EMPLOYEE_STATE_TYPES` is generated
 * from `SupervisorState` so the set cannot drift), which is precisely the
 * property that made one subscription the right answer for checkpoints.
 */
/** The slices this keeps current, each paired with the **shared** function
 * that reads it — the same one `buildFullSnapshot` and the matching IPC
 * handler call, so a pushed patch and a fresh snapshot cannot disagree. */
type WatchedSlice = 'checkpoints' | 'employees' | 'projects' | 'tasks' | 'settings';

const SLICE_READERS: Record<WatchedSlice, (db: Database.Database) => unknown> = {
  checkpoints: listPendingCheckpoints,
  employees: (db) => listEmployees(db),
  // AUDIT M0–M2 #23. These three read exactly what `buildFullSnapshot`
  // reads for the same slice — the point of the whole design is that a
  // pushed patch and a fresh snapshot cannot disagree, and a second way of
  // listing projects would be the drift this file exists to avoid.
  projects: (db) => snapshotSlice(db, 'projects'),
  tasks: (db) => snapshotSlice(db, 'tasks'),
  settings: getAllSettings,
};

/**
 * AUDIT M0–M2 #23 — `projects` and `tasks` have no single shared reader
 * the way `listPendingCheckpoints` and `listEmployees` do; the only place
 * that assembles them is `buildFullSnapshot`, which builds all six.
 *
 * Reaching through it costs a few extra reads per burst and buys the
 * property that matters: **one definition of what a slice contains**
 * (standing rule 6). Re-implementing the list here would be a second
 * definition, agreeing today and free to drift — which is exactly what
 * `buildFullSnapshot`'s own `checkpoints` line was fixed for at M9.
 */
function snapshotSlice(db: Database.Database, slice: 'projects' | 'tasks'): unknown {
  const snapshot = buildFullSnapshot(db);
  // `StateDelta` is a discriminated union and `buildFullSnapshot` only ever
  // returns the `full` arm; narrowing rather than casting keeps that true
  // if the function's return type is ever widened.
  return snapshot.kind === 'full' ? snapshot.slices[slice] : undefined;
}

export function startLiveStateBroadcast(
  activityLog: ActivityLog,
  db: Database.Database,
): () => void {
  // ## Bursts are coalesced into one read and one broadcast
  //
  // Checkpoint events do not arrive one at a time. The timeout sweep can
  // auto-resolve many in a single tick, and §9.3's batching exists
  // precisely because several arrive together — so a broadcast per event
  // would mean N full reads of the pending set and N sends of a list that
  // only changed once. The slice is a whole-array replacement, so all but
  // the last would be redundant by construction.
  //
  // A pending flush is therefore scheduled at most once. `setTimeout(0)`
  // rather than a microtask: `logEvent`'s listeners already run on
  // `setImmediate`, and a burst of those all land in the same timer phase,
  // so one timer collapses the whole burst — a microtask would fire
  // between them and coalesce nothing.
  //
  // One timer per slice rather than one shared timer: a burst of checkpoint
  // events must not drag an employees read along with it, and a slice whose
  // state did not change must not be re-sent — every patch consumes a
  // sequence number the renderer checks for gaps.
  const scheduled: Partial<Record<WatchedSlice, ReturnType<typeof setTimeout>>> = {};

  const schedule = (slice: WatchedSlice): void => {
    if (scheduled[slice] !== undefined) return;
    const timer = setTimeout(() => {
      delete scheduled[slice];
      broadcastPatch(slice, SLICE_READERS[slice](db));
    }, 0);
    timer.unref?.();
    scheduled[slice] = timer;
  };

  const unsubscribe = activityLog.onEvent((entry) => {
    if (entry.type.startsWith('checkpoint.')) schedule('checkpoints');
    // `company.employee_hired`/`_fired` change the roster; `employee.*`
    // changes a row in it. Both are what the Employee bar and the Resume
    // banner render from.
    else if (entry.type.startsWith('employee.') || entry.type.startsWith('company.employee_')) {
      schedule('employees');
    }
    // AUDIT M0–M2 #23 — the other three slices that change while a window
    // is open. §17.2 says the renderer never polls, and before this they
    // arrived only on `did-finish-load`, so the Board could not show a
    // task created while the user was looking at it.
    //
    // `project.*` covers stage changes and brief/plan approvals as well
    // as creation, all of which alter a row the Board reads.
    else if (entry.type.startsWith('project.')) schedule('projects');
    else if (entry.type.startsWith('task.')) schedule('tasks');
    // A single type rather than a prefix: `app.` also carries `started`,
    // `migrated` and `quit`, none of which change a setting, and
    // re-sending a slice nothing touched costs a sequence number the
    // renderer checks for gaps.
    else if (entry.type === 'app.setting_changed') schedule('settings');
  });

  // Teardown clears the pending flush as well as unsubscribing, and that
  // is not tidiness: `runShutdownSequence` calls this immediately before
  // `db.close()`, so a timer left armed would read a closed database on
  // the way out — a crash on quit, in a callback nothing is awaiting.
  return () => {
    for (const slice of Object.keys(scheduled) as WatchedSlice[]) {
      clearTimeout(scheduled[slice]);
      delete scheduled[slice];
    }
    unsubscribe();
  };
}
