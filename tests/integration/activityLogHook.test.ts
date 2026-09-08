import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { ActivityLog, readActivityLogTail } from '../../src/main/db/activityLog';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * AUDIT finding #4: logEvent()'s afterFileWrite test hook must fire
 * exactly between the file write and the mirror insert — the one
 * property the kill-point gate's steps 15/16 need to pin a real kill to,
 * using the real method instead of a hand-rolled simulation.
 */
describe('ActivityLog.logEvent() afterFileWrite hook (AUDIT finding #4)', () => {
  let tmpDir: string;
  let dbPath: string;
  let activityLogPath: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-activitylog-hook-'));
    dbPath = path.join(tmpDir, 'bureau.db');
    activityLogPath = path.join(tmpDir, 'activity.jsonl');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the file has the entry and the mirror does not, at the moment the hook fires', () => {
    const activityLog = ActivityLog.open(activityLogPath, db);
    let observedFileContent = '';
    let observedMirrorCount = -1;

    activityLog.logEvent(
      {
        actor: 'system',
        type: 'app.started',
        severity: 'info',
        project_id: null,
        task_id: null,
        employee_id: null,
        checkpoint_id: null,
        payload: null,
      },
      {
        afterFileWrite: () => {
          observedFileContent = readFileSync(activityLogPath, 'utf8');
          observedMirrorCount = (
            db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }
          ).n;
        },
      },
    );

    expect(observedFileContent, 'file must already have the entry when the hook fires').toContain(
      '"type":"app.started"',
    );
    expect(observedMirrorCount, 'mirror must NOT have it yet when the hook fires').toBe(0);

    // And after logEvent() returns, the mirror does have it — the hook
    // didn't skip or short-circuit the real second half.
    const afterCount = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    expect(afterCount).toBe(1);

    activityLog.close();
  });

  it('behaves identically to a call with no hook at all', () => {
    const activityLog = ActivityLog.open(activityLogPath, db);
    const entry = activityLog.logEvent({
      actor: 'system',
      type: 'app.started',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: null,
    });
    expect(entry.seq).toBe(1);
    const row = db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number };
    expect(row.n).toBe(1);
    activityLog.close();
  });
});

/**
 * AUDIT finding #8: the torn-line tolerance (meant for the one line a hard
 * kill can leave mid-`writeSync`) applied to *every* line during replay,
 * not just the trailing one — silently dropping a mid-file corrupted line
 * instead of treating it as the integrity error it actually is, which
 * could also make `readLastSeq` rewind past later, well-formed entries.
 */
describe('torn-line tolerance is trailing-line-only (AUDIT finding #8)', () => {
  let tmpDir: string;
  let activityLogPath: string;

  const validLine = (seq: number): string =>
    `${JSON.stringify({
      seq,
      id: `id-${seq}`,
      ts: '2026-01-01T00:00:00.000Z',
      actor: 'system',
      type: 'app.started',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: null,
    })}\n`;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-torn-line-'));
    activityLogPath = path.join(tmpDir, 'activity.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tolerates a torn *trailing* line — the real kill-mid-write scenario', () => {
    writeFileSync(activityLogPath, validLine(1) + validLine(2));
    appendFileSync(activityLogPath, '{"seq":3,"id":"trunca'); // torn, no trailing newline
    const tail = readActivityLogTail(activityLogPath, 0);
    expect(tail.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('does NOT tolerate a corrupted line in the middle of the file — that is real corruption, not a torn trailing write', () => {
    writeFileSync(activityLogPath, `${validLine(1)}{"seq":2,not valid json\n${validLine(3)}`);
    expect(() => readActivityLogTail(activityLogPath, 0)).toThrow();
  });
});
