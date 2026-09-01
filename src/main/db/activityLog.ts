import type Database from 'better-sqlite3';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { newId, nowIso } from '../../shared/models/ids';
import { toJsonColumn } from '../../shared/models/json';
import type { ActivityLogEntry, NewEventInput } from '../../shared/models/event';
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
  logEvent(input: NewEventInput, testHooks?: { readonly afterFileWrite?: () => void }): ActivityLogEntry {
    const entry: ActivityLogEntry = {
      seq: this.nextSeq,
      id: newId(),
      ts: nowIso(),
      actor: input.actor,
      type: input.type,
      severity: input.severity,
      project_id: input.project_id,
      task_id: input.task_id,
      employee_id: input.employee_id,
      checkpoint_id: input.checkpoint_id,
      // §11.4 choke point 3/6: every event payload is agent-influenced
      // (tool previews, excerpts, checkpoint context, ...) and this is
      // the ONE place every one of them passes through before becoming
      // durable — the file write below and the mirror insert both read
      // from this same already-redacted value, so redacting here covers
      // both with one call.
      payload: input.payload === null ? null : redactDeep(input.payload),
    };

    // File first, fsync'd, before the mirror insert — this ordering is the
    // entire point of this class.
    const line = `${JSON.stringify(entry)}\n`;
    writeSync(this.fd, line);
    fsyncSync(this.fd);
    this.nextSeq += 1;

    testHooks?.afterFileWrite?.();

    insertMirrorRow(this.db, entry, nowIso());

    return entry;
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Inserts one `events` mirror row for a (possibly already-written)
 * activity log entry. Exported separately so `reconcile()`'s mirror-repair
 * path can reuse the exact same insert logic when replaying the file's
 * tail — it must never diverge from what a normal `logEvent()` call does. */
export function insertMirrorRow(db: Database.Database, entry: ActivityLogEntry, insertedAt: string): void {
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

/** Parses one JSONL line, or returns `null` for a torn trailing write — a
 * hard kill mid-`writeSync` is the one way a line can be incomplete, and
 * an incompletely-written line was never truly durable, so treating it as
 * absent (rather than crashing the whole app on it) is the correct
 * reading, consistent with "commit before act". */
function tryParseLine(line: string): ActivityLogEntry | null {
  try {
    return JSON.parse(line) as ActivityLogEntry;
  } catch {
    return null;
  }
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
  const row = db.prepare('SELECT MAX(seq) as maxSeq FROM events').get() as { maxSeq: number | null };
  return row.maxSeq ?? 0;
}
