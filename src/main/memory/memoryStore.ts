import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { newId, nowIso } from '../../shared/models/ids';
import { toJsonColumn } from '../../shared/models/json';
import { MemoryScopeSchema, type MemoryScope, type MemorySource } from '../../shared/models/enums';
import { MemorySchema, type Memory } from '../../shared/models/memory';
import { getMemoryDir } from '../db/paths';

/**
 * §12.1 layer 1 — "**markdown files (source of truth)**. Human-readable,
 * human-editable, greppable, and survives the app. If Bureau disappears,
 * the knowledge does not."
 *
 * Which makes the ordering here non-negotiable: **the file is written
 * first, the index row second.** A crash between the two loses an index
 * entry, and `rebuildMemoryIndex` puts it back from the file. The reverse
 * ordering would lose the knowledge itself and leave a row pointing at
 * nothing — and no rebuild could recover it.
 *
 * The SQLite `memory` table is layer 2: an index, disposable by
 * construction. Nothing in this module treats it as authoritative.
 */

export interface MemoryLocation {
  readonly scope: MemoryScope;
  /**
   * The project/employee/role this note belongs to, as a POSIX-relative
   * sub-path under the scope directory; null for `company` and `user`,
   * which have no ref.
   *
   * **Path-shaped, not escaped**, and that is a decision worth stating.
   * Roles are addressed everywhere else in the system as `pack:key`
   * (`roles.full_key`), and `:` is not a legal Windows path segment — so
   * `role/engineering:developer/` cannot exist on the platform this ships
   * on. Escaping the colon would leave a directory name that is not the
   * role key and a lossy mapping to reverse on every rebuild. Nesting
   * instead (`role/engineering/developer/`) needs no escaping, reverses
   * exactly, and reads naturally. `memoryScopeRefForRole` is the one place
   * that conversion happens.
   */
  readonly scopeRef: string | null;
  /** File name within the scope directory, e.g. `standards.md`. */
  readonly fileName: string;
}

/** `engineering:developer` → `engineering/developer`. See `scopeRef`. */
export function memoryScopeRefForRole(roleFullKey: string): string {
  return roleFullKey.split(':').join('/');
}

export interface WriteMemoryInput extends MemoryLocation {
  readonly baseDir: string;
  readonly title: string;
  readonly body: string;
  readonly source: MemorySource;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
  /**
   * Test-only seam, called after the markdown file is on disk and **before**
   * the index row is written. It exists so a kill-point test can be killed
   * at exactly that boundary *inside this function*, rather than by a
   * fixture hand-writing the same two calls in its own order — which is
   * AUDIT finding #4's failure mode verbatim ("the ordering under test is
   * the fixture's, not production's"), and is why `ActivityLog.logEvent`
   * already carries the identical `afterFileWrite` hook.
   *
   * Nothing in `src/` passes it.
   */
  readonly afterFileWrite?: (() => void) | undefined;
}

export interface WriteMemoryResult {
  readonly absolutePath: string;
  /** The `memory.path` key — POSIX, relative to the memory root. */
  readonly relativePath: string;
  readonly contentSha256: string;
  /** False when the file already held exactly this content. */
  readonly changed: boolean;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * `memory.path` is UNIQUE (§5.1), so it has to be one canonical string for
 * a given file. POSIX separators and relative-to-the-memory-root, so the
 * same note indexed on two machines — or before and after a userData move
 * — is the same row rather than a duplicate.
 */
export function memoryRelativePath(location: MemoryLocation): string {
  const parts = [
    location.scope,
    ...(location.scopeRef === null ? [] : [location.scopeRef]),
    location.fileName,
  ];
  return parts.join('/');
}

export function memoryAbsolutePath(baseDir: string, location: MemoryLocation): string {
  return path.join(getMemoryDir(baseDir), ...memoryRelativePath(location).split('/'));
}

/** Layer 1 write, then layer 2 index. In that order, for the reason above. */
export function writeMemory(db: Database.Database, input: WriteMemoryInput): WriteMemoryResult {
  const absolutePath = memoryAbsolutePath(input.baseDir, input);
  const relativePath = memoryRelativePath(input);
  const contentSha256 = sha256(input.body);

  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;
  const changed = existing !== input.body;

  if (changed) {
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, input.body, 'utf8');
  }

  input.afterFileWrite?.();

  upsertMemoryRow(db, {
    scope: input.scope,
    scopeRef: input.scopeRef,
    relativePath,
    title: input.title,
    body: input.body,
    contentSha256,
    tags: input.tags ?? [],
    source: input.source,
    pinned: input.pinned ?? false,
    // Stamped from the file that was just written, not from the input —
    // the row records what is on disk, and only the filesystem knows that.
    ...fileStamp(absolutePath),
  });

  return { absolutePath, relativePath, contentSha256, changed };
}

export interface FileStamp {
  readonly fileMtimeMs: number | null;
  readonly fileSize: number | null;
}

/**
 * The cheap half of §12.1's out-of-band edit detection: what the file looked
 * like from the outside, so the reconciler can skip reading it when nothing
 * has moved. **A hint, never the authority** — `content_sha256` is what says
 * whether the index matches, and `nulls` here simply mean "unknown", which
 * forces a read. A file that vanishes between the write and the stat is one
 * of those cases, not an error.
 */
export function fileStamp(absolutePath: string): FileStamp {
  try {
    const stats = statSync(absolutePath);
    return { fileMtimeMs: stats.mtimeMs, fileSize: stats.size };
  } catch {
    return { fileMtimeMs: null, fileSize: null };
  }
}

interface MemoryRow {
  readonly scope: MemoryScope;
  readonly scopeRef: string | null;
  readonly relativePath: string;
  readonly title: string;
  readonly body: string;
  readonly contentSha256: string;
  readonly tags: readonly string[];
  readonly source: MemorySource;
  readonly pinned: boolean;
  readonly fileMtimeMs?: number | null;
  readonly fileSize?: number | null;
}

/**
 * Keyed on `path`, which is the file — so re-indexing an edited file
 * updates its row rather than creating a second one. The FTS triggers
 * (§5.1) fire on the UPDATE, so the index follows without extra work here.
 */
export function upsertMemoryRow(db: Database.Database, row: MemoryRow): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO memory (id, scope, scope_ref, path, title, body, content_sha256, tags, source, pinned, file_mtime_ms, file_size, created_at, updated_at)
     VALUES (@id, @scope, @scope_ref, @path, @title, @body, @content_sha256, @tags, @source, @pinned, @file_mtime_ms, @file_size, @created_at, @updated_at)
     ON CONFLICT(path) DO UPDATE SET
       scope = excluded.scope,
       scope_ref = excluded.scope_ref,
       title = excluded.title,
       body = excluded.body,
       content_sha256 = excluded.content_sha256,
       tags = excluded.tags,
       source = excluded.source,
       file_mtime_ms = excluded.file_mtime_ms,
       file_size = excluded.file_size,
       updated_at = excluded.updated_at`,
    // `pinned` is deliberately not in the update list: it is a user
    // decision about a note, not a property of the file's content, and
    // re-indexing after an edit must not silently unpin something. This
    // omission is the ENTIRE mechanism behind §12.1's "ordinary re-indexing
    // of an edited file does not unpin — only a wipe-and-rebuild does", so
    // it has its own test and its own mutation check.
  ).run({
    id: newId(),
    scope: row.scope,
    scope_ref: row.scopeRef,
    path: row.relativePath,
    title: row.title,
    body: row.body,
    content_sha256: row.contentSha256,
    tags: toJsonColumn(row.tags),
    source: row.source,
    pinned: row.pinned ? 1 : 0,
    file_mtime_ms: row.fileMtimeMs ?? null,
    file_size: row.fileSize ?? null,
    created_at: now,
    updated_at: now,
  });
}

/** First markdown heading, else the filename — the note's own title. */
export function titleFromMarkdown(body: string, fileName: string): string {
  for (const line of body.split('\n')) {
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) return heading[1]!;
  }
  return fileName.replace(/\.md$/i, '');
}

export interface DiscoveredMemoryFile {
  readonly location: MemoryLocation;
  readonly absolutePath: string;
  readonly relativePath: string;
  /** Carried out of the walk because the walk already stat'ed every entry
   *  to find out whether it was a directory. The reconciler compares this
   *  against the row's stamp to decide whether the file is worth reading —
   *  stat'ing a second time would be the same syscall twice. */
  readonly stamp: FileStamp;
}

/**
 * Walks layer 1. Scope comes from the top-level directory the file sits
 * under, exactly as §12.1's tree lays it out; everything between that and
 * the file is the `scopeRef`. Recursive rather than fixed at one level, so
 * `role/engineering/developer/playbook.md` reconstructs its ref
 * (`engineering/developer`) without the walker needing to know that roles
 * are the two-part case.
 *
 * A top-level directory that is not one of the five scopes is skipped
 * rather than guessed at.
 */
export function discoverMemoryFiles(baseDir: string): DiscoveredMemoryFile[] {
  const root = getMemoryDir(baseDir);
  if (!existsSync(root)) return [];

  const found: DiscoveredMemoryFile[] = [];

  const walk = (dir: string, scope: MemoryScope, refParts: string[]): void => {
    for (const entry of readdirSync(dir)) {
      const entryPath = path.join(dir, entry);
      const stats = statSync(entryPath);
      if (stats.isDirectory()) {
        walk(entryPath, scope, [...refParts, entry]);
        continue;
      }
      if (!entry.endsWith('.md')) continue;
      const location: MemoryLocation = {
        scope,
        scopeRef: refParts.length === 0 ? null : refParts.join('/'),
        fileName: entry,
      };
      found.push({
        location,
        absolutePath: entryPath,
        relativePath: memoryRelativePath(location),
        stamp: { fileMtimeMs: stats.mtimeMs, fileSize: stats.size },
      });
    }
  };

  for (const scopeName of readdirSync(root)) {
    const scopeParse = MemoryScopeSchema.safeParse(scopeName);
    if (!scopeParse.success) continue;
    const scopeDir = path.join(root, scopeName);
    if (!statSync(scopeDir).isDirectory()) continue;
    walk(scopeDir, scopeParse.data, []);
  }

  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function readMemoryFile(file: DiscoveredMemoryFile): string {
  return readFileSync(file.absolutePath, 'utf8');
}

/**
 * One discovered file, by its canonical `memory.path` key — what
 * `memory.read` needs when it reconciles a single note rather than the whole
 * tree. Built by describing the ONE file rather than walking and filtering,
 * so reading one note does not cost a full directory walk.
 *
 * Returns `null` when the file is not there, which is the caller's signal
 * that the row (if any) describes something that no longer exists.
 */
export function describeMemoryFile(
  baseDir: string,
  location: MemoryLocation,
): DiscoveredMemoryFile | null {
  const absolutePath = memoryAbsolutePath(baseDir, location);
  if (!existsSync(absolutePath)) return null;
  const stats = statSync(absolutePath);
  if (!stats.isFile()) return null;
  return {
    location,
    absolutePath,
    relativePath: memoryRelativePath(location),
    stamp: { fileMtimeMs: stats.mtimeMs, fileSize: stats.size },
  };
}

export function getMemoryRowByPath(db: Database.Database, relativePath: string): Memory | null {
  const row = db.prepare('SELECT * FROM memory WHERE path = ?').get(relativePath);
  return row ? MemorySchema.parse(row) : null;
}

/** Removes the index row for a path. The FTS index follows through §5.1's
 *  delete trigger; deleting from `memory_fts` directly would desynchronise
 *  it from `memory`. */
export function deleteMemoryRowByPath(db: Database.Database, relativePath: string): boolean {
  return db.prepare('DELETE FROM memory WHERE path = ?').run(relativePath).changes > 0;
}

/**
 * Reverses `memoryRelativePath`. The layout is `<scope>/<ref…>/<file>.md`
 * and the walker already reconstructs a ref from however many segments sit
 * between the scope and the file (§12.1: roles are the two-segment case and
 * nothing special-cases them), so this reads the same way from a stored key.
 *
 * `null` for a path whose first segment is not one of the five scopes —
 * skipped rather than guessed at, exactly as the walker skips such a
 * directory.
 */
export function locationFromRelativePath(relativePath: string): MemoryLocation | null {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const scope = MemoryScopeSchema.safeParse(segments[0]);
  if (!scope.success) return null;
  const fileName = segments[segments.length - 1] as string;
  const refParts = segments.slice(1, -1);
  return {
    scope: scope.data,
    scopeRef: refParts.length === 0 ? null : refParts.join('/'),
    fileName,
  };
}
