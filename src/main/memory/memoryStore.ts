import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { newId, nowIso } from '../../shared/models/ids';
import { toJsonColumn } from '../../shared/models/json';
import { MemoryScopeSchema, type MemoryScope, type MemorySource } from '../../shared/models/enums';
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
  const parts = [location.scope, ...(location.scopeRef === null ? [] : [location.scopeRef]), location.fileName];
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
  });

  return { absolutePath, relativePath, contentSha256, changed };
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
}

/**
 * Keyed on `path`, which is the file — so re-indexing an edited file
 * updates its row rather than creating a second one. The FTS triggers
 * (§5.1) fire on the UPDATE, so the index follows without extra work here.
 */
export function upsertMemoryRow(db: Database.Database, row: MemoryRow): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO memory (id, scope, scope_ref, path, title, body, content_sha256, tags, source, pinned, created_at, updated_at)
     VALUES (@id, @scope, @scope_ref, @path, @title, @body, @content_sha256, @tags, @source, @pinned, @created_at, @updated_at)
     ON CONFLICT(path) DO UPDATE SET
       scope = excluded.scope,
       scope_ref = excluded.scope_ref,
       title = excluded.title,
       body = excluded.body,
       content_sha256 = excluded.content_sha256,
       tags = excluded.tags,
       source = excluded.source,
       updated_at = excluded.updated_at`,
    // `pinned` is deliberately not in the update list: it is a user
    // decision about a note, not a property of the file's content, and
    // re-indexing after an edit must not silently unpin something.
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
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath, scope, [...refParts, entry]);
        continue;
      }
      if (!entry.endsWith('.md')) continue;
      const location: MemoryLocation = {
        scope,
        scopeRef: refParts.length === 0 ? null : refParts.join('/'),
        fileName: entry,
      };
      found.push({ location, absolutePath: entryPath, relativePath: memoryRelativePath(location) });
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
