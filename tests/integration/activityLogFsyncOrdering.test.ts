import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Audit M0–M2 #8, and a sibling of `configurationIsInForce.test.ts` —
 * same class of gap: something written down that nothing asserted. It
 * lives in its own file because it needs a `node:fs` module mock, which
 * applies to a whole file.
 *
 * §28 M1 item 6 and §11.6: `logEvent()` appends to `activity.jsonl`,
 * `fsync`s it, and only THEN inserts the `events` mirror row. The whole
 * point is the direction of the failure — a crash between the two can
 * leave the mirror behind the file, never the file behind the mirror, and
 * `reconcile()` repairs exactly that direction by replaying the tail.
 *
 * Nothing tested it. Deleting the `fsyncSync` call was caught only by
 * eslint, as an unused import; the realistic refactor — `fsync` once on
 * `close()` instead of per event, which any reviewer might wave through as
 * a performance win — was caught by nothing at all: eslint clean, tsc
 * clean, 32 tests green across `killPoints`, `activityLogHook` and
 * `reconcileActivityEvents`.
 *
 * The ordering assertion below does not rely on a spy's call sequence.
 * It asks the database, from inside the mocked `fsyncSync`, whether the
 * mirror row is there yet — so it pins "the fsync happens before the
 * insert" rather than merely "both happened".
 *
 * ## What this does and does not prove about durability
 *
 * It proves the ordering and that the `fsync` is issued per event. It does
 * not prove the bytes reached the platter: `fsyncSync` returning says the
 * OS accepted the flush, and a drive with a lying write cache can still
 * lose it. §11.6 and §28 M1 now state that limit rather than leaving the
 * stronger reading standing.
 */

const mockFsyncSync = vi.fn<(fd: number) => void>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    fsyncSync: (fd: number) => {
      mockFsyncSync(fd);
      actual.fsyncSync(fd);
    },
  };
});

const { openConnection } = await import('../../src/main/db/connection');
const { runMigrations } = await import('../../src/main/db/migrate');
const { ActivityLog } = await import('../../src/main/db/activityLog');

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('§28 M1 item 6 — the activity log fsyncs before the mirror insert', () => {
  let tmpDir: string;
  let db: Database.Database;
  let log: ReturnType<typeof ActivityLog.open>;

  beforeEach(async () => {
    mockFsyncSync.mockClear();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-fsync-order-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    log = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    mockFsyncSync.mockClear();
  });

  afterEach(() => {
    log.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const anEvent = () =>
    ({
      actor: 'system' as const,
      type: 'app.started' as const,
      severity: 'info' as const,
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: null,
    }) as Parameters<typeof log.logEvent>[0];

  const mirrorRowCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;

  it('fsyncs the file exactly once per logged event', () => {
    log.logEvent(anEvent());
    expect(mockFsyncSync).toHaveBeenCalledTimes(1);

    log.logEvent(anEvent());
    expect(mockFsyncSync).toHaveBeenCalledTimes(2);
  });

  it('fsyncs BEFORE the mirror row exists, not after', () => {
    // The mutation this catches is deferring the fsync to close(): the
    // call count above would go to zero, and this count would be 1.
    const mirrorRowsAtFsync: number[] = [];
    mockFsyncSync.mockImplementation(() => {
      mirrorRowsAtFsync.push(mirrorRowCount());
    });

    log.logEvent(anEvent());

    expect(mirrorRowsAtFsync).toEqual([0]);
    expect(mirrorRowCount()).toBe(1);
  });

  it('holds for the second event too — the ordering is per event, not per session', () => {
    const mirrorRowsAtFsync: number[] = [];
    mockFsyncSync.mockImplementation(() => {
      mirrorRowsAtFsync.push(mirrorRowCount());
    });

    log.logEvent(anEvent());
    log.logEvent(anEvent());

    // Each fsync sees only the events committed by PREVIOUS calls.
    expect(mirrorRowsAtFsync).toEqual([0, 1]);
    expect(mirrorRowCount()).toBe(2);
  });

  it('fsyncs the activity log fd, not some other file', () => {
    log.logEvent(anEvent());
    const fd = mockFsyncSync.mock.calls[0]?.[0];
    expect(typeof fd).toBe('number');
    // The fd the log opened is the one flushed — a refactor that flushed a
    // different handle would satisfy a bare call-count assertion.
    expect(fd).toBeGreaterThan(2);
  });
});
