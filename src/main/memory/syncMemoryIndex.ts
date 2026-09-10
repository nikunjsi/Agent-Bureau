import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import {
  deleteMemoryRowByPath,
  describeMemoryFile,
  discoverMemoryFiles,
  getMemoryRowByPath,
  locationFromRelativePath,
  readMemoryFile,
  sha256,
  titleFromMarkdown,
  upsertMemoryRow,
  type DiscoveredMemoryFile,
} from './memoryStore';

/**
 * §28's M10 item 1 — "file watching for out-of-band edits via
 * `content_sha256`" — and **the only place disk is reconciled against the
 * index**.
 *
 * ## Why one function with a scope, rather than two functions
 *
 * `memory.read` needs the same answer for a single note that a full sync
 * needs for the tree: has the file changed, has it been deleted, does the
 * row need rebuilding, and does that count as a state change worth an event.
 * A second implementation for the one-file case would be the shape standing
 * rule 6 names — two functions that each pass their own tests and are free
 * to drift on the interesting cases (a changed hash, a changed title, a path
 * that now collides) while agreeing on the boring one (the file is gone).
 *
 * So callers choose **what** to reconcile. They never decide **how**.
 *
 * ## Stat before hash
 *
 * The reconciler runs before every memory-pack composition and every search,
 * so it cannot afford to read and hash the whole tree each time. The walk
 * already stats every entry, so the stat comes free; a file whose
 * `mtime`/`size` match the row's stamp is skipped without being opened.
 *
 * The stamp is a **skip hint, not the authority**: `content_sha256` is what
 * decides whether the row matches, and a file edited so as to leave both
 * mtime and size unchanged is the case a stamp cannot see. That case has a
 * user-reachable repair — `{ kind: 'force' }`, which `memory.reindex` uses —
 * so it is a bounded, fixable staleness rather than a silent one.
 *
 * ## What it never does
 *
 * It never touches `pinned`. `upsertMemoryRow` omits that column from its
 * UPDATE list, which is the entire mechanism behind §12.1's *"ordinary
 * re-indexing of an edited file does not unpin — only a wipe-and-rebuild
 * does"*. Deleting a row whose file is gone does of course lose its pin, and
 * that is not a special case: the note itself is gone.
 */

export type ReconcileScope =
  /** The whole tree. Startup, pack composition, search, list. */
  | { readonly kind: 'all' }
  /** Named `memory.path` keys only — `memory.read`'s single note. */
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  /** The whole tree, hashing every file regardless of its stamp. The repair
   *  for a stamp that lied; what `memory.reindex` runs. */
  | { readonly kind: 'force' };

export interface ReconcileResult {
  /** Rows written because the file was new or its content had changed. */
  readonly indexed: number;
  /** Rows removed because their file is no longer on disk. */
  readonly removed: number;
  /** Files whose stamp matched, so they were never opened. */
  readonly skipped: number;
  readonly changed: boolean;
}

export function reconcileMemory(
  db: Database.Database,
  baseDir: string,
  activityLog: ActivityLog | undefined,
  scope: ReconcileScope = { kind: 'all' },
): ReconcileResult {
  const files = collectFiles(db, baseDir, scope);
  const alwaysHash = scope.kind === 'force';

  let indexed = 0;
  let removed = 0;
  let skipped = 0;

  const apply = db.transaction(() => {
    for (const file of files) {
      const row = getMemoryRowByPath(db, file.relativePath);

      if (file.present === null) {
        // The row describes a note that is no longer there. Layer 1 is the
        // source of truth (§12.1), so the file's absence is the fact and
        // the row is what is wrong.
        if (row !== null && deleteMemoryRowByPath(db, file.relativePath)) removed += 1;
        continue;
      }

      const present = file.present;
      if (!alwaysHash && row !== null && stampMatches(row, present)) {
        skipped += 1;
        continue;
      }

      const body = readMemoryFile(present);
      const contentSha256 = sha256(body);
      if (row !== null && row.content_sha256 === contentSha256) {
        // Same content behind a moved stamp — a touch, a copy, a checkout.
        // Not a change to the knowledge, so not an index write and not an
        // event; but the stamp is refreshed so the next pass can skip it.
        db.prepare(
          `UPDATE memory SET file_mtime_ms = @mtime, file_size = @size WHERE path = @path`,
        ).run({
          mtime: present.stamp.fileMtimeMs,
          size: present.stamp.fileSize,
          path: file.relativePath,
        });
        skipped += 1;
        continue;
      }

      upsertMemoryRow(db, {
        scope: present.location.scope,
        scopeRef: present.location.scopeRef,
        relativePath: present.relativePath,
        title: titleFromMarkdown(body, present.location.fileName),
        body,
        contentSha256,
        tags: [],
        // `imported` is honest for a file discovered on disk: whatever wrote
        // it, this index row was built by reading it, not by being told.
        source: 'imported',
        // Only ever consulted on INSERT — the upsert leaves an existing
        // row's pin alone. A note discovered for the first time is unpinned.
        pinned: false,
        fileMtimeMs: present.stamp.fileMtimeMs,
        fileSize: present.stamp.fileSize,
      });
      indexed += 1;
    }
  });

  apply();

  const changed = indexed > 0 || removed > 0;
  if (changed) {
    // Emitted only when something actually changed. A reconcile that finds
    // the index already correct is not a state change, and an event every
    // time we merely *looked* would turn "exactly one event per state
    // change" into noise — the same rule `company.pack_validated` follows.
    activityLog?.logEvent({
      actor: 'system',
      type: 'memory.indexed',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { indexed, removed, skipped, reason: scope.kind === 'force' ? 'forced' : 'sync' },
    });
  }

  return { indexed, removed, skipped, changed };
}

/** The whole tree. Startup, memory-pack composition, search and list. */
export function syncMemoryIndexFromDisk(
  db: Database.Database,
  baseDir: string,
  activityLog?: ActivityLog,
): ReconcileResult {
  return reconcileMemory(db, baseDir, activityLog, { kind: 'all' });
}

/** One note, by its `memory.path` key. `memory.read`'s entry point: it
 *  chooses the path, this decides everything else. */
export function reconcileMemoryPath(
  db: Database.Database,
  baseDir: string,
  relativePath: string,
  activityLog?: ActivityLog,
): ReconcileResult {
  return reconcileMemory(db, baseDir, activityLog, { kind: 'paths', paths: [relativePath] });
}

// ---- internals -----------------------------------------------------

/** A path to reconcile, and the file behind it if there is one. `present:
 *  null` means the row (if any) is describing something deleted. */
interface Candidate {
  readonly relativePath: string;
  readonly present: DiscoveredMemoryFile | null;
}

function collectFiles(db: Database.Database, baseDir: string, scope: ReconcileScope): Candidate[] {
  if (scope.kind === 'paths') {
    const out: Candidate[] = [];
    for (const relativePath of scope.paths) {
      const location = locationFromRelativePath(relativePath);
      // A path that does not parse names no note in the tree. Treated as
      // absent rather than skipped, so a row under a bogus key is cleaned up
      // rather than left forever.
      const present = location === null ? null : describeMemoryFile(baseDir, location);
      out.push({ relativePath, present });
    }
    return out;
  }

  const discovered = discoverMemoryFiles(baseDir);
  const seen = new Set(discovered.map((file) => file.relativePath));
  const out: Candidate[] = discovered.map((file) => ({
    relativePath: file.relativePath,
    present: file,
  }));

  // Rows whose file the walk did not find. Only a whole-tree scope can know
  // this — a single-path reconcile has no view of what else exists, which is
  // exactly why the scope is a parameter rather than something this function
  // guesses at.
  const indexed = db.prepare('SELECT path FROM memory').all() as { path: string }[];
  for (const row of indexed) {
    if (!seen.has(row.path)) out.push({ relativePath: row.path, present: null });
  }
  return out;
}

function stampMatches(
  row: { file_mtime_ms: number | null; file_size: number | null },
  file: DiscoveredMemoryFile,
): boolean {
  // A null stamp means "unknown" — every row written before migration 0010
  // has one — and unknown must force a read. Failing toward more work is the
  // right direction for a cache.
  return (
    row.file_mtime_ms !== null &&
    row.file_size !== null &&
    row.file_mtime_ms === file.stamp.fileMtimeMs &&
    row.file_size === file.stamp.fileSize
  );
}
