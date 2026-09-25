import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { listPendingCheckpoints } from '../db/repositories/checkpoints';
import { listEmployees } from '../db/repositories/employees';
import { getAllSettings } from '../db/repositories/settings';
import { activeProjectId } from '../projects/activeProject';
import { broadcastPatch, SLICE_READERS as SNAPSHOT_READERS } from './stateDelta';

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
type WatchedSlice = 'checkpoints' | 'employees' | 'projects' | 'tasks' | 'settings' | 'company';

const SLICE_READERS: Record<WatchedSlice, (db: Database.Database) => unknown> = {
  checkpoints: listPendingCheckpoints,
  employees: (db) => listEmployees(db),
  // AUDIT M0–M2 #23, then M11 S2-5 (`NEXT-VERSION` §N.5). These three read
  // exactly what `buildFullSnapshot` reads for the same slice, through the
  // same function (`stateDelta.ts`'s `SLICE_READERS`) — so a pushed patch and
  // a fresh snapshot cannot disagree. They used to reach through the whole
  // snapshot, which re-read all six slices to send one; each is now its own
  // reader, and `tasks` is the active project's only.
  projects: SNAPSHOT_READERS.projects,
  tasks: SNAPSHOT_READERS.tasks,
  settings: getAllSettings,
  // The sixth, and the last one that only arrived on load (AUDIT M0–M2 #23's
  // residual, done at pre-M11 §C). The company row carries the floor layout,
  // and hiring rewrites it: `persistFloorLayout` emits
  // `company.floor_rearranged` on every hire, fire and desk move, so a user
  // watching the floor while someone is hired was looking at a layout the
  // database had already replaced.
  company: SNAPSHOT_READERS.company,
};

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
  // Which project's tasks the windows were last given, so a message that
  // moves the active project re-sends the slice and one that does not, does
  // not (each patch consumes a sequence number).
  let lastActiveProject = activeProjectId(db);

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
      // Hiring and firing move desks, and the desks live on the company
      // row (`companies.floor_layout`). ONE event, two slices: the hire
      // emits `company.employee_hired` and `persistFloorLayout` writes the
      // layout inside the same call without an event of its own — which is
      // invariant #3 holding (one state change, one event), and the reason
      // this cannot be routed by event name alone.
      if (entry.type.startsWith('company.employee_')) schedule('company');
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
    // M11 S2-5: the tasks slice is the active project's, and a message is
    // what moves the active project (`activeProjectId`). Re-sent only when
    // it actually moved: every other message leaves the Board as it was.
    else if (entry.type === 'chat.message_persisted') {
      const active = activeProjectId(db);
      if (active !== lastActiveProject) {
        lastActiveProject = active;
        schedule('tasks');
      }
    }
    // A single type rather than a prefix: `app.` also carries `started`,
    // `migrated` and `quit`, none of which change a setting, and
    // re-sending a slice nothing touched costs a sequence number the
    // renderer checks for gaps.
    else if (entry.type === 'app.setting_changed') schedule('settings');
    // Named types, not the `company.` prefix: that prefix also carries pack
    // installs and validations, which change no company row.
    // `floor_rearranged` is the explicit rearrange (a desk moved, or pins
    // were dropped); `created` is the first-run company, which a window
    // open through setup would otherwise never see.
    else if (entry.type === 'company.floor_rearranged' || entry.type === 'company.created') {
      schedule('company');
    }
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
