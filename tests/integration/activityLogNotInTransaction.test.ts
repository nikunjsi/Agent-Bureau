import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { ActivityLog } from '../../src/main/db/activityLog';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * AUDIT M0–M2 #29's remaining half, done at pre-M11 §C: **`logEvent` refuses
 * to run inside a transaction.**
 *
 * The fix session corrected the comment — mid-transaction logging is not done
 * and must not be — and recorded the runtime guard as the obvious next step.
 * This is that step, and the reason it is worth a throw on the hottest write
 * path is the failure mode, which is not a tidiness issue:
 *
 *  - The JSONL line is written and **fsync'd before** the mirror insert, and
 *    the file is the authoritative record (§11.6). A rollback therefore leaves
 *    the log permanently claiming a state change that never happened —
 *    invariant #3 broken in the durable direction.
 *  - `repairMirror` replays only entries after `MAX(seq)`, so the hole the
 *    rolled-back insert leaves *below* the high-water mark is never repaired.
 *
 * Both are silent. A throw at the top is the only version of this rule that
 * cannot be forgotten by the next author, and it is fail-closed (invariant #6):
 * the write is refused rather than half-made.
 */
describe('logEvent refuses to write inside a transaction (AUDIT M0–M2 #29)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let logPath: string;

  const event = {
    actor: 'system' as const,
    type: 'app.started' as const,
    severity: 'info' as const,
    payload: {},
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-log-txn-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    logPath = path.join(tmpDir, 'activity.jsonl');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(logPath, db);
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const fileLines = (): string[] =>
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '');

  it('writes normally outside one', () => {
    activityLog.logEvent(event);

    expect(fileLines()).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
  });

  it('throws inside one, and writes nothing at all — not even the file', () => {
    const inside = db.transaction(() => {
      activityLog.logEvent(event);
    });

    expect(() => inside()).toThrow(/transaction/i);

    // The file is the authoritative record, so "nothing at all" has to
    // include it: a line written and then rolled back is the permanent lie
    // this guard exists to prevent.
    expect(fileLines()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
  });

  it('says what to do instead, because the fix is always the same', () => {
    const inside = db.transaction(() => activityLog.logEvent(event));

    expect(() => inside()).toThrow(/after the (commit|transaction)/i);
  });

  it('is unharmed by a transaction that has already finished', () => {
    db.transaction(() => {
      db.prepare('SELECT 1').get();
    })();

    activityLog.logEvent(event);

    expect(fileLines()).toHaveLength(1);
  });
});
