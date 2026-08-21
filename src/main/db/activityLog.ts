import type Database from 'better-sqlite3';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { newId, nowIso } from '../../shared/models/ids';
import { toJsonColumn } from '../../shared/models/json';
import type { ActivityLogEntry, NewEventInput } from '../../shared/models/event';

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
    filePath: string,
    private readonly db: Database.Database,
    startingSeq: number,
  ) {
    this.fd = openSync(filePath, 'a');
    this.nextSeq = startingSeq;
  }

  static open(filePath: string, db: Database.Database): ActivityLog {
    return new ActivityLog(filePath, db, readLastSeq(filePath) + 1);
  }

  logEvent(input: NewEventInput): ActivityLogEntry {
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
      payload: input.payload,
    };

    // File first, fsync'd, before the mirror insert — this ordering is the
    // entire point of this class.
    const line = `${JSON.stringify(entry)}\n`;
    writeSync(this.fd, line);
    fsyncSync(this.fd);
    this.nextSeq += 1;

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

function readAllEntries(filePath: string): ActivityLogEntry[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const entries: ActivityLogEntry[] = [];
  for (const line of lines) {
    const parsed = tryParseLine(line);
    if (parsed !== null) entries.push(parsed);
  }
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
