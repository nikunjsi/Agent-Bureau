import type Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { MemoryScopeSchema, type MemoryScope } from '../../shared/models/enums';
import { memoryAbsolutePath, sha256, titleFromMarkdown, writeMemory } from './memoryStore';

/**
 * §6.2's `memory-seed/` directory. A pack ships knowledge as well as roles
 * — engineering conventions, a house style — and installing it puts those
 * notes into layer 1 where the user can read and edit them like any other.
 *
 * **Layout.** `memory-seed/<scope>/…` mirrors §12.1's own tree, so a pack
 * can seed a role playbook (`memory-seed/role/<key>/playbook.md`) as well
 * as company standards. Files placed directly in `memory-seed/` seed
 * `company/`, which is what §6.2's own example
 * (`memory-seed/engineering-conventions.md`) implies.
 *
 * **A file the user has since edited is never overwritten.** Layer 1 is
 * human-editable by design, so the pack loses that race deliberately: a
 * reinstall or upgrade must not silently revert someone's notes. Detection
 * is by content hash against what the pack would write, so an unmodified
 * file is refreshed and a modified one is left alone and reported.
 */

export interface SeedMemoryResult {
  readonly written: string[];
  readonly skippedUserEdited: string[];
}

interface SeedFile {
  readonly absolutePath: string;
  readonly scope: MemoryScope;
  readonly scopeRef: string | null;
  readonly fileName: string;
}

function collectSeedFiles(seedRoot: string): SeedFile[] {
  if (!existsSync(seedRoot) || !statSync(seedRoot).isDirectory()) return [];

  const files: SeedFile[] = [];

  // Recursive to whatever depth the scope's refs need, mirroring
  // `discoverMemoryFiles`. A role's ref is two segments
  // (`role/engineering/developer/`), so a walker fixed at one level would
  // silently skip every role playbook a pack ships.
  const walk = (dir: string, scope: MemoryScope, refParts: string[]): void => {
    for (const entry of readdirSync(dir)) {
      const entryPath = path.join(dir, entry);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath, scope, [...refParts, entry]);
        continue;
      }
      if (!entry.endsWith('.md')) continue;
      files.push({
        absolutePath: entryPath,
        scope,
        scopeRef: refParts.length === 0 ? null : refParts.join('/'),
        fileName: entry,
      });
    }
  };

  for (const entry of readdirSync(seedRoot)) {
    const entryPath = path.join(seedRoot, entry);

    if (!statSync(entryPath).isDirectory()) {
      // §6.2's own example: a bare file seeds company scope.
      if (entry.endsWith('.md')) {
        files.push({ absolutePath: entryPath, scope: 'company', scopeRef: null, fileName: entry });
      }
      continue;
    }

    const scopeParse = MemoryScopeSchema.safeParse(entry);
    if (!scopeParse.success) continue;
    walk(entryPath, scopeParse.data, []);
  }

  return files.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
}

export function seedPackMemory(
  db: Database.Database,
  options: { readonly packRootDir: string; readonly baseDir: string },
): SeedMemoryResult {
  const written: string[] = [];
  const skippedUserEdited: string[] = [];

  for (const seed of collectSeedFiles(path.join(options.packRootDir, 'memory-seed'))) {
    const body = readFileSync(seed.absolutePath, 'utf8');
    const location = { scope: seed.scope, scopeRef: seed.scopeRef, fileName: seed.fileName };
    const target = memoryAbsolutePath(options.baseDir, location);

    if (existsSync(target)) {
      const current = readFileSync(target, 'utf8');
      // Identical: writing is a no-op, so let it fall through and refresh
      // the index row. Different: the user edited it, and the pack loses.
      if (sha256(current) !== sha256(body)) {
        skippedUserEdited.push(target);
        continue;
      }
    }

    const result = writeMemory(db, {
      baseDir: options.baseDir,
      scope: seed.scope,
      scopeRef: seed.scopeRef,
      fileName: seed.fileName,
      title: titleFromMarkdown(body, seed.fileName),
      body,
      source: 'imported',
      // X-14: a pack seeding company or role memory is stating the standing
      // rule, and §12.3's pack clauses read PINNED notes — so an unpinned seed
      // is a standard no employee ever sees. `writeMemory` never rewrites
      // `pinned` on a row that already exists (§12.1), so this pins on first
      // seed and never undoes a user's later unpin.
      pinned: true,
    });
    written.push(result.absolutePath);
  }

  return { written, skippedUserEdited };
}
