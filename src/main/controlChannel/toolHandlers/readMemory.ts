import { ReadMemoryArgsSchema } from './schemas';
import { getEmployeeById } from '../../db/repositories/employees';
import { getRoleByFullKey } from '../../db/repositories/roles';
import { searchMemory } from '../../memory/searchMemory';
import { syncMemoryIndexFromDisk } from '../../memory/syncMemoryIndex';
import { semanticSearchState } from '../../memory/memoryPack';
import { MemoryScopeSchema, type MemoryScope } from '../../../shared/models/enums';
import type { ToolHandler } from './types';

/**
 * §7.9's `bureau_read_memory` — "FTS search over the scopes this role may
 * read". Real from M10.
 *
 * It was **HONEST EMPTY** from M4 until now: it returned a well-formed empty
 * result naming the milestone that would fill it, rather than an error or a
 * silent "no results" indistinguishable from a real search finding nothing.
 * That distinction is why nothing had to be untangled here — the empty
 * result was never a lie, so making it real is a replacement rather than a
 * correction.
 *
 * ## Scopes come from the role, not from the request
 *
 * `role.memory_scopes` (§6.5) is what a role may read, and it is looked up
 * from the authenticated employee rather than accepted as an argument — the
 * same principle every other handler follows for resource ids. A role with
 * no scopes reads nothing, and that is a legal configuration, not a bug to
 * paper over by defaulting to everything.
 *
 * ## No activity event
 *
 * A read changes nothing, and §5.2's rule is one event per *state-changing*
 * operation. The index reconcile below can emit `memory.indexed` — but only
 * if it actually changed the index, which is a state change of its own.
 */
export const handleReadMemory: ToolHandler = (ctx, rawArgs) => {
  const parsed = ReadMemoryArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_read_memory: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const employee = getEmployeeById(ctx.db, ctx.employeeId);
  const role = employee === null ? null : getRoleByFullKey(ctx.db, employee.role_key);
  if (role === null) {
    return {
      ok: false,
      // Not VALIDATION_FAILED: nothing about the agent's arguments caused
      // this and nothing it can change will fix it, so telling it to correct
      // its call would send it round a loop. §7.9's own rule — an error an
      // agent reads has to be one it can act on, including "you cannot".
      code: 'INTERNAL_ERROR',
      message:
        'bureau_read_memory: your role could not be found, so the scopes you may read are ' +
        'unknown. This is a Bureau-side problem, not something your arguments can fix.',
    };
  }

  const scopes: MemoryScope[] = [];
  for (const raw of role.memory_scopes) {
    const scope = MemoryScopeSchema.safeParse(raw);
    if (scope.success) scopes.push(scope.data);
  }

  if (scopes.length === 0) {
    return {
      ok: true,
      data: {
        results: [],
        reason: 'Your role is configured to read no memory scopes, so there is nothing to search.',
      },
    };
  }

  // Layer 1 is the source of truth and a person may have edited it since the
  // index was last built (§12.1). Cheap: the reconciler stats before it
  // hashes, so an unchanged tree opens no files.
  syncMemoryIndexFromDisk(ctx.db, ctx.baseDir, ctx.activityLog);

  // `searchMemory`, not the raw FTS wrapper: `toFtsQuery` quotes every token
  // because an agent's query can legitimately contain `-` or `NEAR`, which
  // FTS5 reads as operators.
  const results = searchMemory(ctx.db, parsed.data.query, {
    scopes,
    limit: parsed.data.k,
    pinnedFirst: true,
  });

  return {
    ok: true,
    data: {
      results: results.map((row) => ({
        path: row.path,
        title: row.title,
        scope: row.scope,
        pinned: row.pinned,
        content: row.body,
      })),
      // §12.1's degrade-loudly: if the user asked for semantic search and
      // there is no local model, these are keyword results and the agent is
      // told so rather than being left to assume otherwise.
      semantic: semanticSearchState(ctx.db),
    },
  };
};
