import type Database from 'better-sqlite3';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { newId, nowIso } from '../../shared/models/ids';
import { toJsonColumn } from '../../shared/models/json';
import type { ActivityLogEntry, NewEventInput } from '../../shared/models/event';
import { ActivityLogEntrySchema, NewEventInputSchema } from '../../shared/models/event';
import { redactDeep } from '../secrets/redactor';

/**
 * `logEvent()` is the **only** way to write an event (§21 invariant,
 * CLAUDE.md). It appends to `activity.jsonl` and `fsync`s **before**
 * inserting the `events` mirror row (§11.6) — a crash between the two can
 * only ever leave the mirror behind, never the file, and `reconcile()`
 * repairs that by replaying the file's tail.
 */
export class ActivityLog {
  private readonly fd: number;
  private nextSeq: number;
  private readonly listeners = new Set<(entry: ActivityLogEntry) => void>();

  private constructor(
    public readonly filePath: string,
    private readonly db: Database.Database,
    startingSeq: number,
  ) {
    this.fd = openSync(filePath, 'a');
    this.nextSeq = startingSeq;
  }

  static open(filePath: string, db: Database.Database): ActivityLog {
    return new ActivityLog(filePath, db, readLastSeq(filePath) + 1);
  }

  /**
   * `afterFileWrite` is a **test-only** seam (AUDIT finding #4): the
   * kill-point durability gate needs to pin a process kill precisely
   * between the file write and the mirror insert to prove §11.6's
   * ordering — the one property this class exists for. Reimplementing
   * those two steps by hand in the test (as it previously did) proves
   * nothing about this method; calling the real `logEvent()` with a hook
   * that pauses at exactly that internal boundary does. Never passed by
   * any production caller.
   */
  logEvent(
    input: NewEventInput,
    testHooks?: { readonly afterFileWrite?: () => void },
  ): ActivityLogEntry {
    // AUDIT M0–M2 #2. `NewEventInputSchema` existed from M1 and had ZERO
    // production callers — it was validated only in tests, which means the
    // taxonomy was closed at typecheck and open at runtime. Anything
    // reaching this method through an `as`, a JSON boundary or a widened
    // type wrote whatever it liked.
    //
    // Parsing FIRST, before the file write, is the load-bearing part:
    // validating after the append would leave the file permanently ahead
    // of the mirror, which is the one direction §11.6's ordering is not
    // designed to repair.
    //
    // It also applies the schema's defaults, which is why `severity` and
    // the four correlation ids can now be omitted by a caller.
    const validated = NewEventInputSchema.parse(input);

    const entry: ActivityLogEntry = {
      seq: this.nextSeq,
      id: newId(),
      ts: nowIso(),
      actor: validated.actor,
      type: validated.type,
      severity: validated.severity,
      project_id: validated.project_id,
      task_id: validated.task_id,
      employee_id: validated.employee_id,
      checkpoint_id: validated.checkpoint_id,
      // §11.4 choke point 3/6: every event payload is agent-influenced
      // (tool previews, excerpts, checkpoint context, ...) and this is
      // the ONE place every one of them passes through before becoming
      // durable — the file write below and the mirror insert both read
      // from this same already-redacted value, so redacting here covers
      // both with one call.
      payload: validated.payload === null ? null : redactDeep(validated.payload),
    };

    // File first, fsync'd, before the mirror insert — this ordering is the
    // entire point of this class.
    const line = `${JSON.stringify(entry)}\n`;
    writeSync(this.fd, line);
    fsyncSync(this.fd);
    this.nextSeq += 1;

    testHooks?.afterFileWrite?.();

    insertMirrorRow(this.db, entry, nowIso());
    this.notify(entry);

    return entry;
  }

  /**
   * Subscribe to every event as it is written. Returns an unsubscribe
   * function.
   *
   * This exists so that "something changed, tell the windows" has **one**
   * trigger instead of one per call site (M9's `liveState.ts` is the first
   * subscriber). Every state change already emits exactly one event —
   * CLAUDE.md invariant #3 — so subscribing to the events is subscribing to
   * the state changes, and a new code path that changes state cannot forget
   * to notify without also forgetting its event, which is a thing tests
   * already check for.
   *
   * Two properties listeners can rely on, and one they must not:
   *
   *  - **Deferred.** Listeners run on `setImmediate`, never synchronously
   *    inside `logEvent`. That is defence in depth, and it is **not** a
   *    licence to log mid-transaction (AUDIT M0–M2 #29 — this comment used
   *    to say `logEvent` "is frequently called mid-transaction", which was
   *    false and read as permission).
   *
   *    **`logEvent` is not called inside a `db.transaction(...)` anywhere in
   *    `src/`, and must not be.** Every writer commits first and logs after
   *    — re-verified at fix 3b with a brace-matching scan of all 18
   *    transaction bodies, direct calls and calls to any of the 39 named
   *    functions that log, with an injected call confirming the scan sees
   *    one. (The scan does not follow class methods or arrow functions
   *    passed in, so treat it as evidence, not proof.)
   *
   *    Two things go wrong if a transaction logs and then rolls back, and
   *    neither is recoverable by anything that exists today:
   *      1. **The file records a state change that never happened.** The
   *         JSONL line is fsync'd before the mirror insert, and the file is
   *         the authoritative record (§11.6) — so the log now permanently
   *         claims something invariant #3 says it may only claim after
   *         commit.
   *      2. **The mirror gets a hole nothing repairs.** The mirror insert
   *         rolls back with the transaction, but `nextSeq` has already
   *         advanced, so the next committed event takes a higher `seq`.
   *         `reconcile()`'s `repairMirror` replays only entries *after*
   *         `MAX(seq)`, so a gap *below* the high-water mark is invisible
   *         to it forever.
   *    If logging inside a transaction is ever genuinely needed, the fix is
   *    not this comment: `repairMirror` would have to detect holes rather
   *    than trust the high-water mark, and (1) would need a design of its
   *    own.
   *  - **Isolated.** A throwing listener is logged to the console and
   *    otherwise ignored. A push failure must never take down the state
   *    change that caused it.
   *  - **Not durable.** This is a live, in-process signal. Anything that
   *    must survive a restart belongs in the database, not here.
   */
  onEvent(listener: (entry: ActivityLogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(entry: ActivityLogEntry): void {
    if (this.listeners.size === 0) return;
    const listeners = [...this.listeners];
    setImmediate(() => {
      for (const listener of listeners) {
        try {
          listener(entry);
        } catch (err) {
          console.error('[activityLog] a live listener threw; the event itself is unaffected', err);
        }
      }
    });
  }

  close(): void {
    this.listeners.clear();
    closeSync(this.fd);
  }
}

/** Inserts one `events` mirror row for a (possibly already-written)
 * activity log entry. Exported separately so `reconcile()`'s mirror-repair
 * path can reuse the exact same insert logic when replaying the file's
 * tail — it must never diverge from what a normal `logEvent()` call does. */
export function insertMirrorRow(
  db: Database.Database,
  entry: ActivityLogEntry,
  insertedAt: string,
): void {
  db.prepare(
    `INSERT INTO events (seq, id, ts, actor, type, severity, project_id, task_id, employee_id, checkpoint_id, payload, created_at)
     VALUES (@seq, @id, @ts, @actor, @type, @severity, @project_id, @task_id, @employee_id, @checkpoint_id, @payload, @created_at)`,
  ).run({
    seq: entry.seq,
    id: entry.id,
    ts: entry.ts,
    actor: entry.actor,
    type: entry.type,
    severity: entry.severity,
    project_id: entry.project_id,
    task_id: entry.task_id,
    employee_id: entry.employee_id,
    checkpoint_id: entry.checkpoint_id,
    payload: entry.payload === null ? null : toJsonColumn(entry.payload),
    created_at: insertedAt,
  });
}

/**
 * Parses one JSONL line, or returns `null` for a line that is not a
 * well-formed entry — a hard kill mid-`writeSync` is the one way a line
 * can be incomplete, and an incompletely-written line was never truly
 * durable, so treating it as absent (rather than crashing the whole app on
 * it) is the correct reading, consistent with "commit before act".
 *
 * AUDIT M0–M2 #2: this was `JSON.parse(line) as ActivityLogEntry` — a
 * cast, not a check, and `ActivityLogEntrySchema` had no production caller
 * at all. The shape that makes it SERIOUS is a line whose `seq` is absent:
 * it parses as JSON perfectly well, so the cast passed it straight
 * through, and `insertMirrorRow` then bound `undefined` to an
 * `INTEGER PRIMARY KEY`, which SQLite **auto-assigns**. The mirror
 * silently desynchronised from the file that `getMaxMirrorSeq()` reads as
 * its high-water mark, and every later repair replayed from the wrong
 * place.
 *
 * The caller's asymmetry is deliberate and unchanged: an unusable line is
 * tolerated ONLY as the file's last line, and is corruption anywhere else.
 * Structural invalidity now gets exactly the same treatment as invalid
 * JSON, because a torn write can land on a byte boundary that still
 * parses.
 *
 * **State the consequence plainly, because it is a real behaviour change:**
 * a mid-file line that parses as JSON but is not a valid entry used to be
 * trusted silently and now raises `CorruptActivityLogError`, which reaches
 * `ActivityLog.open` and `reconcile()` — so it stops the app from booting.
 * That is deliberate and matches what this file already did for invalid
 * JSON in the same position (invariant #6, fail closed): the activity log
 * is the source of truth the `events` table mirrors, and a silently
 * mis-parsed one is worse than a loud refusal. The narrower alternative —
 * skip the bad line and carry on — was rejected because skipping a line
 * silently renumbers nothing but leaves `MAX(seq)` and the file
 * permanently disagreeing, which is the exact desync this finding is
 * about.
 */
function tryParseLine(line: string): ActivityLogEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = ActivityLogEntrySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** AUDIT finding #8: the torn-write tolerance is only ever correct for the
 * file's last line — every write before that one either completed and
 * fsync'd, or this line wouldn't exist at all (§11.6, append-only,
 * single writer). A malformed line anywhere else is real corruption, not
 * a torn write, and silently dropping it (as this used to, for every
 * line) could both lose data and make `readLastSeq` rewind past later,
 * well-formed entries. */
class CorruptActivityLogError extends Error {
  constructor(filePath: string, lineNumber: number) {
    super(
      `${filePath}: line ${lineNumber} is not valid JSON and is not the ` +
        `file's last line — this is corruption, not a torn write from a ` +
        `kill mid-append.`,
    );
    this.name = 'CorruptActivityLogError';
  }
}

function readAllEntries(filePath: string): ActivityLogEntry[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const entries: ActivityLogEntry[] = [];
  lines.forEach((line, index) => {
    const parsed = tryParseLine(line);
    if (parsed !== null) {
      entries.push(parsed);
    } else if (index !== lines.length - 1) {
      throw new CorruptActivityLogError(filePath, index + 1);
    }
    // else: torn trailing line — tolerated, silently dropped.
  });
  return entries;
}

function readLastSeq(filePath: string): number {
  const entries = readAllEntries(filePath);
  if (entries.length === 0) return 0;
  const last = entries[entries.length - 1];
  return last === undefined ? 0 : last.seq;
}

/** Reads every entry from `activity.jsonl` whose `seq` is greater than
 * `afterSeq` — the tail `reconcile()`'s mirror repair replays. */
export function readActivityLogTail(filePath: string, afterSeq: number): ActivityLogEntry[] {
  return readAllEntries(filePath).filter((entry) => entry.seq > afterSeq);
}

/** The mirror's current high-water mark — `reconcile()`'s mirror repair
 * replays everything after it. Lives here, not as a raw query in
 * reconcile.ts, since `events` has no repository file of its own:
 * `ActivityLog`/`insertMirrorRow` are its sole writer per §21, so this is
 * its equivalent read-side owner. */
export function getMaxMirrorSeq(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(seq) as maxSeq FROM events').get() as {
    maxSeq: number | null;
  };
  return row.maxSeq ?? 0;
}
