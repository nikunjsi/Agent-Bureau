import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { createBackup, listBackups, restoreFromBackup } from '../../../src/main/db/backup';
import { checkIntegrity } from '../../../src/main/db/connection';
import { seedProject } from '../../helpers/dbFixtures';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * AUDIT M0–M2 #3 — §28 M1 item 8's recovery path.
 *
 * `listBackups` and `restoreFromBackup` had **zero callers in `src/` and
 * zero in `tests/`**; coverage confirmed it independently at 13.6%. This
 * is the first test that actually runs a restore.
 *
 * ## The bug the dead code was hiding
 *
 * `restoreFromBackup` was a bare `copyFileSync`. The database runs in WAL
 * mode (§5.0), which means committed data lives in `<db>-wal` until a
 * checkpoint folds it back into the main file. Copying a backup over
 * `bureau.db` while a stale `bureau.db-wal` is sitting beside it does not
 * restore the backup: the next connection replays that WAL on top of the
 * file just copied in, and the user gets a mix of the backup and whatever
 * the corrupt database was doing.
 *
 * Its own comment reasoned about the *destination being open* — "caller
 * must ensure the live connection is closed first" — and never about the
 * leftover WAL. The scenario it exists for is restore-after-crash, which
 * is exactly when an uncheckpointed WAL is on disk.
 *
 * These tests leave a genuine crash-shaped WAL behind, so a restore that
 * only copies the main file fails them.
 */
describe('restoreFromBackup (§28 M1 item 8, audit #3)', () => {
  let tmpDir: string;
  let dbPath: string;
  let backupsDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-restore-'));
    dbPath = path.join(tmpDir, 'bureau.db');
    backupsDir = path.join(tmpDir, 'backups');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const projectNames = (conn: Database.Database): string[] =>
    (conn.prepare('SELECT name FROM projects ORDER BY name').all() as { name: string }[]).map(
      (r) => r.name,
    );

  it('lists backups newest first, and finds the one createBackup just made', async () => {
    // Migrations take their own `bureau.db.pre-NNNN.bak` before each step
    // (§28 M1 item 2), so a freshly migrated directory already has one per
    // migration. That is worth asserting rather than assuming — it is the
    // set a recovery flow would actually be offering the user.
    const preMigration = listBackups(backupsDir);
    expect(preMigration.length, 'one pre-migration backup per applied migration').toBeGreaterThan(
      0,
    );
    expect(preMigration.every((b) => b.filename.endsWith('.bak'))).toBe(true);

    const madePath = await createBackup(db, backupsDir);
    const listed = listBackups(backupsDir);

    expect(listed.map((b) => b.path)).toContain(madePath);
    expect(listed.length).toBe(preMigration.length + 1);
    // Newest first — the ordering "offer the most recent backup" relies on.
    expect(listed[0]?.filename, 'the manual backup is the newest').toMatch(/^bureau\.db\.manual-/);
  });

  it('restores the backup contents, with a crash-shaped WAL left on disk', async () => {
    // The state at backup time.
    seedProject(db, { name: 'Before Backup' });
    const backupPath = await createBackup(db, backupsDir);

    // Work done AFTER the backup, committed but still living in the WAL —
    // this is the data a restore is supposed to discard.
    seedProject(db, { name: 'After Backup' });
    expect(projectNames(db)).toEqual(['After Backup', 'Before Backup']);

    // A crash: the connection dies without a checkpoint, so `-wal` and
    // `-shm` are still on disk beside the database. `db.close()` would
    // checkpoint and remove them, which is exactly the case that does NOT
    // need this fix — so the WAL is recreated deliberately below.
    db.close();
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(0));
    expect(existsSync(`${dbPath}-wal`), 'a stale WAL is beside the database').toBe(true);

    restoreFromBackup(backupPath, dbPath);

    // The sidecars must be gone — a restore that leaves them lets the next
    // connection replay a WAL belonging to a different database file.
    expect(existsSync(`${dbPath}-wal`), 'the stale WAL must not survive a restore').toBe(false);
    expect(existsSync(`${dbPath}-shm`), 'nor the shared-memory file').toBe(false);

    const restored = openConnection(dbPath);
    try {
      expect(projectNames(restored)).toEqual(['Before Backup']);
      expect(checkIntegrity(restored).ok, 'the restored database is sound').toBe(true);
    } finally {
      restored.close();
    }
  });

  it('restores over a genuinely uncheckpointed WAL carrying real committed rows', async () => {
    // The strong version, and the one that matters: the post-backup write
    // is still IN the WAL, unreplayed, exactly as a killed process leaves
    // it. `db.close()` checkpoints and deletes the sidecars, so closing
    // would destroy the very condition under test — instead the live
    // three-file state is copied aside while the connection is still open,
    // which is byte-for-byte what a crash leaves behind.
    seedProject(db, { name: 'Only This One' });
    const backupPath = await createBackup(db, backupsDir);

    seedProject(db, { name: 'Lost To Restore' });
    expect(existsSync(`${dbPath}-wal`), 'the write is sitting in the WAL').toBe(true);

    // Snapshot the three live files into memory. They have to be captured
    // BEFORE close(), because close() checkpoints and deletes the WAL —
    // the exact state being reproduced.
    const crashedBytes = {
      db: readFileSync(dbPath),
      wal: readFileSync(`${dbPath}-wal`),
      shm: existsSync(`${dbPath}-shm`) ? readFileSync(`${dbPath}-shm`) : null,
    };
    db.close();

    const crashedDir = path.join(tmpDir, 'crashed');
    mkdirSync(crashedDir, { recursive: true });
    const crashedDb = path.join(crashedDir, 'bureau.db');
    const layDownCrashedState = (): void => {
      writeFileSync(crashedDb, crashedBytes.db);
      writeFileSync(`${crashedDb}-wal`, crashedBytes.wal);
      if (crashedBytes.shm) writeFileSync(`${crashedDb}-shm`, crashedBytes.shm);
    };

    // Sanity: the crashed state really does carry the later write in its
    // WAL. Without this the test could pass for the wrong reason — an
    // empty WAL proves nothing (standing rule 9).
    layDownCrashedState();
    const crashedBefore = openConnection(crashedDb);
    expect(projectNames(crashedBefore), 'the WAL replays the post-backup write').toEqual([
      'Lost To Restore',
      'Only This One',
    ]);
    crashedBefore.close();

    // Re-create the uncheckpointed state that close() just folded away.
    layDownCrashedState();

    restoreFromBackup(backupPath, crashedDb);

    const restored = openConnection(crashedDb);
    try {
      expect(
        projectNames(restored),
        'the WAL must not be replayed on top of the restored file',
      ).toEqual(['Only This One']);
    } finally {
      restored.close();
    }
  });
});
