import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import {
  discoverMemoryFiles,
  readMemoryFile,
  sha256,
  titleFromMarkdown,
  upsertMemoryRow,
} from './memoryStore';

/**
 * §12.1 layer 2: "**rebuildable from Layer 1 at any time**."
 *
 * Built now rather than deferred, because that sentence is the entire
 * justification for keeping the knowledge in markdown files. An index
 * described as disposable but with no code that disposes of it is a claim
 * nobody has tested — and the test for this one deletes every row and
 * proves search still works afterwards, which is the only evidence that
 * matters.
 *
 * Wipes and re-derives in ONE transaction: a rebuild that failed halfway
 * would leave the index worse than before it started, which is the one
 * outcome a repair operation must not have.
 */

export interface RebuildResult {
  readonly indexed: number;
  readonly removed: number;
}

export function rebuildMemoryIndex(
  db: Database.Database,
  baseDir: string,
  activityLog?: ActivityLog,
): RebuildResult {
  const files = discoverMemoryFiles(baseDir);

  const rebuild = db.transaction(() => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number }).n;
    // The FTS index follows through the §5.1 delete trigger; deleting the
    // FTS rows directly would desynchronise it from `memory`.
    db.prepare('DELETE FROM memory').run();

    for (const file of files) {
      const body = readMemoryFile(file);
      upsertMemoryRow(db, {
        scope: file.location.scope,
        scopeRef: file.location.scopeRef,
        relativePath: file.relativePath,
        title: titleFromMarkdown(body, file.location.fileName),
        body,
        contentSha256: sha256(body),
        tags: [],
        source: 'imported',
        // A rebuild derives everything from the files, and pinning is not
        // in a file. It is lost on rebuild, and that is worth knowing
        // rather than pretending otherwise — §12 has no layer-1
        // representation for it yet, and inventing frontmatter for it here
        // would be a spec change made silently.
        pinned: false,
      });
    }

    return before;
  });

  const before = rebuild();

  activityLog?.logEvent({
    actor: 'system',
    type: 'memory.indexed',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: { indexed: files.length, removed: before, reason: 'rebuild' },
  });

  return { indexed: files.length, removed: before };
}
