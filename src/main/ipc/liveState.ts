import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { listPendingCheckpoints } from '../db/repositories/checkpoints';
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
 * It does not decide anything. It re-reads `listPendingCheckpoints` — the
 * same function `checkpoints.listPending`, `CheckpointSurfacer` and the
 * full snapshot all call — and sends what it finds. §9.4's "all reflecting
 * one piece of state" is a property of sharing that call; a broadcaster
 * that maintained its own idea of the pending set would be the fifth
 * surface disagreeing with the other four.
 */
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
  let scheduled: ReturnType<typeof setTimeout> | null = null;

  const unsubscribe = activityLog.onEvent((entry) => {
    if (!entry.type.startsWith('checkpoint.')) return;
    if (scheduled !== null) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      broadcastPatch('checkpoints', listPendingCheckpoints(db));
    }, 0);
    scheduled.unref?.();
  });

  // Teardown clears the pending flush as well as unsubscribing, and that
  // is not tidiness: `runShutdownSequence` calls this immediately before
  // `db.close()`, so a timer left armed would read a closed database on
  // the way out — a crash on quit, in a callback nothing is awaiting.
  return () => {
    if (scheduled !== null) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    unsubscribe();
  };
}
