import { unlinkSync, existsSync } from 'node:fs';
import { ipcError, ipcOk } from '../../../shared/ipc/envelope';
import { Memory as MemorySchemas } from '../../../shared/ipc/schemas/memory';
import { getMemoryById, setMemoryPinned } from '../../db/repositories/memory';
import { listPendingProposals } from '../../db/repositories/memoryProposals';
import {
  deleteMemoryRowByPath,
  getMemoryRowByPath,
  memoryAbsolutePath,
  titleFromMarkdown,
  writeMemory,
} from '../../memory/memoryStore';
import { rebuildMemoryIndex } from '../../memory/rebuildMemoryIndex';
import { reconcileMemoryPath, syncMemoryIndexFromDisk } from '../../memory/syncMemoryIndex';
import { searchMemory } from '../../memory/searchMemory';
import { semanticSearchState } from '../../memory/memoryPack';
import { describeMemoryTargetRefusal, resolveMemoryTarget } from '../../memory/memoryTarget';
import type { Handler, HandlerContext } from './types';
import type { Memory } from '../../../shared/models/memory';

/**
 * §17.1's `memory` namespace — the memory view's whole surface, and the one
 * place a *person* writes to memory.
 *
 * ## Every read reconciles first
 *
 * §12.1 makes the markdown files the source of truth and the SQLite rows a
 * disposable index over them, and §28's M10 item 1 asks for out-of-band
 * edits to be detected via `content_sha256`. So a read here does not trust
 * the index: it reconciles the relevant part of layer 1 first, through the
 * one reconciler (`syncMemoryIndex.ts`). A user who edits `standards.md` in
 * a text editor and then opens this view sees what they wrote, not what
 * Bureau last remembered.
 *
 * That is affordable because the reconciler stats before it hashes — a pass
 * over an unchanged tree opens no files. See migration `0010`.
 *
 * ## The write path is confined here, not by policy
 *
 * `memory.write` and `memory.remove` both go through `resolveMemoryTarget`.
 * That is not belt-and-braces: for anything reaching memory this IS the
 * guard, because the agent-facing equivalent is a `bureau_` tool that the
 * policy evaluator allows before it ever scans a deny (AUDIT #10, and
 * CLAUDE.md invariant #5's carve-out). A path arriving over IPC is no more
 * trusted than one arriving from an agent.
 */

function pinnedOnlyChange(input: { body?: string | undefined }): boolean {
  return input.body === undefined;
}

export const memoryHandlers: Record<string, Handler> = {
  list: (input, ctx) => {
    const parsed = MemorySchemas.list.input.parse(input);
    syncMemoryIndexFromDisk(ctx.db, ctx.baseDir, ctx.activityLog);

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (parsed.scope !== undefined) {
      conditions.push('scope = @scope');
      params['scope'] = parsed.scope;
    }
    if (parsed.scopeRef !== undefined && parsed.scopeRef !== null) {
      conditions.push('scope_ref = @scopeRef');
      params['scopeRef'] = parsed.scopeRef;
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = ctx.db.prepare(`SELECT * FROM memory ${where} ORDER BY path`).all(params);

    return ipcOk({
      items: rows.map((row) => MemorySchemas.list.output.shape.items.element.parse(row)),
      proposals: listPendingProposals(ctx.db),
    });
  },

  read: (input, ctx) => {
    const { id } = MemorySchemas.read.input.parse(input);
    const existing = getMemoryById(ctx.db, id);
    if (existing === null) return ipcOk({ item: null });

    // The path is what identifies the file; the id identifies the row. A
    // reconcile keyed on the path is what lets this answer "the file is
    // gone" rather than handing back a row describing nothing.
    reconcileMemoryPath(ctx.db, ctx.baseDir, existing.path, ctx.activityLog);
    return ipcOk({ item: getMemoryRowByPath(ctx.db, existing.path) });
  },

  write: (input, ctx) => {
    const parsed = MemorySchemas.write.input.parse(input);

    // The guard. See this file's header, and `memoryTarget.ts`.
    const target = resolveMemoryTarget(ctx.baseDir, {
      scope: parsed.scope,
      path: parsed.path,
      // A person writing through the UI is not an employee, so there is no
      // owning employee id — which is exactly why `employee` scope refuses
      // here. The user's own notes live in `user/`; `employee/` is an
      // individual's notebook and belongs to that individual.
      employeeId: null,
    });
    if (!target.ok) {
      return ipcError('VALIDATION_FAILED', describeMemoryTargetRefusal(target.refusal));
    }

    if (pinnedOnlyChange(parsed)) {
      // A pin is a real state change with no layer-1 representation (§12.1),
      // so it touches the row and not the file.
      const row = getMemoryRowByPath(ctx.db, target.relativePath);
      if (row === null) {
        return ipcError(
          'NOT_FOUND',
          'There is no note at that path to pin. Write the note first, then pin it.',
        );
      }
      if (row.pinned === (parsed.pinned ?? false)) {
        // Nothing changed, so nothing is committed and no event is emitted —
        // an event per request rather than per state change would make the
        // activity log a request log (invariant #3).
        return ipcOk({ item: row });
      }

      setMemoryPinned(ctx.db, { id: row.id }, parsed.pinned === true);

      ctx.activityLog.logEvent({
        actor: 'user',
        type: 'memory.write_applied',
        severity: 'info',
        project_id: null,
        task_id: null,
        employee_id: null,
        checkpoint_id: null,
        // §5.2 distinguishes cases with a field rather than by adding
        // taxonomy (`git.worktree_released`'s `reason`,
        // `company.employee_hired`'s `rehired`). A sixth `memory.*` type for
        // pinning would be a change to a closed enum for a variant of "a
        // write to memory was applied".
        payload: {
          change: parsed.pinned === true ? 'pinned' : 'unpinned',
          path: row.path,
          memoryId: row.id,
        },
      });

      return ipcOk({ item: getMemoryById(ctx.db, row.id) as Memory });
    }

    const body = parsed.body as string;
    const before = getMemoryRowByPath(ctx.db, target.relativePath);
    const result = writeMemory(ctx.db, {
      baseDir: ctx.baseDir,
      ...target.location,
      title: parsed.title ?? titleFromMarkdown(body, target.location.fileName),
      body,
      source: 'user_stated',
      ...(parsed.pinned === undefined ? {} : { pinned: parsed.pinned }),
    });

    // `writeMemory` does not update `pinned` on an existing row, by design
    // (§12.1: re-indexing must not unpin). So an explicit pin alongside a
    // body edit is applied here, where it is a stated intent rather than a
    // side effect of indexing.
    if (parsed.pinned !== undefined && before !== null && before.pinned !== parsed.pinned) {
      setMemoryPinned(ctx.db, { path: result.relativePath }, parsed.pinned === true);
    }

    const row = getMemoryRowByPath(ctx.db, result.relativePath) as Memory;
    ctx.activityLog.logEvent({
      actor: 'user',
      type: 'memory.write_applied',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: {
        change: before === null ? 'created' : 'updated',
        scope: parsed.scope,
        path: result.relativePath,
        memoryId: row.id,
        gated: false,
      },
    });

    return ipcOk({ item: row });
  },

  remove: (input, ctx) => {
    const { id } = MemorySchemas.remove.input.parse(input);
    const row = getMemoryById(ctx.db, id);
    // Already gone is the outcome the caller wanted, not a failure — and
    // `remove` is the one operation a user is most likely to fire twice.
    if (row === null) return ipcOk({ ok: true });

    const target = resolveMemoryTarget(ctx.baseDir, {
      scope: row.scope,
      // Rebuilt from the stored path minus its scope segment, so the same
      // confinement runs over a row as over a request. A row is not
      // automatically trusted just because it is in the database.
      path: row.path.split('/').slice(1).join('/'),
      employeeId: row.scope === 'employee' ? row.scope_ref : null,
    });
    if (!target.ok) {
      return ipcError('VALIDATION_FAILED', describeMemoryTargetRefusal(target.refusal));
    }

    // Layer 1 first, matching the write ordering and for the same reason
    // (§12.1): a crash between the two leaves a row pointing at a file that
    // is gone, which the next reconcile removes. The reverse would leave the
    // note on disk with nothing indexing it — silently un-searchable.
    const absolutePath = memoryAbsolutePath(ctx.baseDir, target.location);
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
    deleteMemoryRowByPath(ctx.db, row.path);

    ctx.activityLog.logEvent({
      actor: 'user',
      type: 'memory.write_applied',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { change: 'deleted', scope: row.scope, path: row.path, memoryId: row.id },
    });

    return ipcOk({ ok: true });
  },

  search: (input, ctx) => {
    const { query } = MemorySchemas.search.input.parse(input);
    syncMemoryIndexFromDisk(ctx.db, ctx.baseDir, ctx.activityLog);
    return ipcOk({
      // Through the sanitising search, never the raw FTS wrapper: a query a
      // person typed can contain `-`, `"` or `NEAR`, which FTS5 reads as
      // operators. `toFtsQuery` already handles that, and text with no
      // searchable tokens matches nothing rather than everything.
      items: searchMemory(ctx.db, query, { pinnedFirst: true }),
      semantic: semanticSearchState(ctx.db),
    });
  },

  reindex: (input, ctx) => {
    const { full } = MemorySchemas.reindex.input.parse(input);

    if (full) {
      // §12.1's wipe-and-rebuild. `pinsCleared` is returned rather than
      // logged and forgotten: losing pins is the documented cost of this
      // repair, and the caller is the one who has to tell the user.
      const result = rebuildMemoryIndex(ctx.db, ctx.baseDir, ctx.activityLog);
      return ipcOk(result);
    }

    // The incremental path hashes only what moved and never touches
    // `pinned`, so no pin is ever lost here — 0 is a fact, not a placeholder.
    const result = syncMemoryIndexFromDisk(ctx.db, ctx.baseDir, ctx.activityLog);
    return ipcOk({ indexed: result.indexed, removed: result.removed, pinsCleared: 0 });
  },
};

export type { HandlerContext };
