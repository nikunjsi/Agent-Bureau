import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { writeMemory } from '../../../src/main/memory/memoryStore';
import { syncMemoryIndexFromDisk } from '../../../src/main/memory/syncMemoryIndex';
import { dispatchIpcCall } from '../../../src/main/ipc/router';
import { getHandler } from '../../../src/main/ipc/handlers';
import { IPC_SCHEMAS } from '../../../src/shared/ipc/schemas';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * X-13 / §12.1's M10 amendment: **"`memory.reindex` hashes
 * unconditionally"** — the stated repair for a stamp that lies.
 *
 * `syncMemoryIndex` skips any file whose `mtime`/`size` match the row's
 * stamp, which is right for the reconcile that runs before every search and
 * every pack composition. Its own comment names the case a stamp cannot see —
 * a file edited to the same length and restamped to the same mtime — and says
 * the repair is `{ kind: 'force' }`, "which `memory.reindex` uses". It did
 * not: the handler called the stamp-skipping path, so the one user-reachable
 * repair for a lying stamp repaired nothing, and the only thing that did was
 * `full: true`, which clears every pin.
 *
 * The file below is edited in exactly that way. Nothing here mocks the clock
 * or the stat: `utimesSync` puts the real timestamps back, so the row's stamp
 * genuinely matches a file whose content no longer does.
 */
describe('memory.reindex re-reads a file whose stamp lies, and keeps pins (X-13)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;

  const NOTE = {
    scope: 'company' as const,
    scopeRef: null,
    fileName: 'standards.md',
    title: 'Standards',
    source: 'user_stated' as const,
  };
  const ROW_PATH = 'company/standards.md';

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-reindex-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    ctx = {
      db,
      activityLog,
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
    } as HandlerContext;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function row(): { content_sha256: string; pinned: number; title: string } {
    return db
      .prepare('SELECT content_sha256, pinned, title FROM memory WHERE path = ?')
      .get(ROW_PATH) as { content_sha256: string; pinned: number; title: string };
  }

  /**
   * A whole second, so putting it back is exact: `utimesSync` rounds, and a
   * restored mtime that differs by a fraction of a millisecond would make the
   * stamp mismatch — the test would then pass for the ordinary reason rather
   * than the one it is about.
   */
  const FIXED_MTIME = new Date('2026-01-01T12:00:00.000Z');

  /** An edit a stamp cannot see: same byte length, same mtime afterwards. */
  function editInvisibly(absolutePath: string, body: string): void {
    const before = statSync(absolutePath);
    writeFileSync(absolutePath, body, 'utf8');
    utimesSync(absolutePath, FIXED_MTIME, FIXED_MTIME);
    const after = statSync(absolutePath);
    expect(after.size, 'the edit must not change the size').toBe(before.size);
    expect(after.mtimeMs, 'the edit must not change the mtime').toBe(FIXED_MTIME.getTime());
  }

  async function reindex(full: boolean): Promise<Record<string, unknown>> {
    const result = await dispatchIpcCall(
      'memory:reindex',
      IPC_SCHEMAS.memory.reindex,
      getHandler('memory', 'reindex'),
      ctx,
      true,
      { full },
    );
    expect(result.ok, JSON.stringify(result).slice(0, 200)).toBe(true);
    return (result as { ok: true; data: Record<string, unknown> }).data;
  }

  it('re-indexes the changed file and leaves the pin alone', async () => {
    const written = writeMemory(db, {
      baseDir: tmpDir,
      ...NOTE,
      body: '# Standards\n\nUse tabs for indentation.\n',
    });
    utimesSync(written.absolutePath, FIXED_MTIME, FIXED_MTIME);
    syncMemoryIndexFromDisk(db, tmpDir, activityLog);
    db.prepare('UPDATE memory SET pinned = 1 WHERE path = ?').run(ROW_PATH);
    const before = row();

    // Same length, same mtime — 'tabs' and 'code' are both four characters.
    editInvisibly(written.absolutePath, '# Standards\n\nUse code for indentation.\n');

    const result = await reindex(false);

    expect(row().content_sha256, 'the row still describes the old content').not.toBe(
      before.content_sha256,
    );
    expect(result['indexed']).toBe(1);
    expect(result['pinsCleared']).toBe(0);
    expect(row().pinned, '§12.1: only a wipe-and-rebuild clears a pin').toBe(1);
  });

  it('still reports what a full rebuild costs', async () => {
    writeMemory(db, {
      baseDir: tmpDir,
      ...NOTE,
      body: '# Standards\n\nUse tabs for indentation.\n',
    });
    syncMemoryIndexFromDisk(db, tmpDir, activityLog);
    db.prepare('UPDATE memory SET pinned = 1 WHERE path = ?').run(ROW_PATH);

    const result = await reindex(true);

    expect(result['pinsCleared']).toBe(1);
    expect(row().pinned).toBe(0);
  });
});
