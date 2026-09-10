import type Database from 'better-sqlite3';
import { MemorySchema, type Memory } from '../../shared/models/memory';
import type { MemoryScope } from '../../shared/models/enums';

/**
 * §12.1 layer 2's read path, with the scope filtering §12.3's memory pack
 * needs (a role reads only the scopes its `memory_scopes` names).
 *
 * Extends `src/main/db/repositories/memory.ts`'s `searchMemory` rather than
 * replacing it: that one is the plain FTS wrapper M1 shipped, this one adds
 * the filtering and the query sanitisation retrieval needs. Both hit the
 * same table and the same triggers.
 */

export interface SearchMemoryOptions {
  /** Restrict to these scopes. Empty or absent means all of them. */
  readonly scopes?: readonly MemoryScope[];
  /** Restrict to one project/employee/role within its scope. */
  readonly scopeRef?: string | null;
  readonly limit?: number;
  /** Pinned notes first, then relevance. §12.3 composes packs this way. */
  readonly pinnedFirst?: boolean;
  /**
   * Restrict to notes whose file has one of these names — §12.3's "relevant
   * past lessons", which is a distinct clause of the memory pack and needs
   * its own budget rather than competing for the general top-K.
   *
   * A file-name list rather than a glob on purpose: §12.1's tree gives every
   * scope a small, known set of file names (`lessons.md`, `playbook.md`,
   * `decisions.md`), and a pattern language here would be a second query
   * grammar in a function whose whole point is that it sanitises the one it
   * already has.
   */
  readonly fileNames?: readonly string[];
}

/**
 * FTS5's MATCH argument is a query LANGUAGE, not a literal — a task title
 * containing `-`, `"`, `*` or `NEAR` is either a syntax error or, worse, a
 * silently different query. Task text goes in here verbatim (§12.3 searches
 * on it), so every token is quoted and turned into a plain OR-of-terms.
 * Quotes inside a token are doubled, which is FTS5's own escape.
 */
export function toFtsQuery(raw: string): string | null {
  const tokens = raw
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`);
  return tokens.length === 0 ? null : tokens.join(' OR ');
}

const DEFAULT_LIMIT = 20;

export function searchMemory(
  db: Database.Database,
  query: string,
  options: SearchMemoryOptions = {},
): Memory[] {
  const ftsQuery = toFtsQuery(query);
  // A query with no searchable tokens matches nothing. Returning
  // everything instead would silently blow through `memory_budget_tokens`.
  if (ftsQuery === null) return [];

  const conditions: string[] = ['memory_fts MATCH @query'];
  const params: Record<string, unknown> = {
    query: ftsQuery,
    limit: options.limit ?? DEFAULT_LIMIT,
  };

  const scopes = options.scopes ?? [];
  if (scopes.length > 0) {
    // Named parameters, one per scope — an interpolated IN list would put
    // caller-supplied strings into SQL text.
    const names = scopes.map((_, index) => `@scope${index}`);
    conditions.push(`m.scope IN (${names.join(', ')})`);
    scopes.forEach((scope, index) => {
      params[`scope${index}`] = scope;
    });
  }
  if (options.scopeRef !== undefined && options.scopeRef !== null) {
    conditions.push('m.scope_ref = @scopeRef');
    params['scopeRef'] = options.scopeRef;
  }

  const fileNames = options.fileNames ?? [];
  if (fileNames.length > 0) {
    // Matched on the path's last segment. Named parameters, one per name,
    // for the same reason the scope list uses them: an interpolated IN list
    // would put caller-supplied strings into SQL text.
    const names = fileNames.map((_, index) => `@file${index}`);
    conditions.push(
      `(${names.map((name) => `m.path = ${name} OR m.path LIKE '%/' || ${name}`).join(' OR ')})`,
    );
    fileNames.forEach((fileName, index) => {
      params[`file${index}`] = fileName;
    });
  }

  const order = options.pinnedFirst === true ? 'm.pinned DESC, rank' : 'rank';

  const rows = db
    .prepare(
      `SELECT m.* FROM memory m
         JOIN memory_fts ON memory_fts.rowid = m.rowid
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${order}
        LIMIT @limit`,
    )
    .all(params);
  return rows.map((row) => MemorySchema.parse(row));
}

/** Everything pinned in a scope, regardless of the query — §12.3's
 * "pinned company standards" half of the memory pack. */
export function listPinnedMemory(
  db: Database.Database,
  scope: MemoryScope,
  scopeRef: string | null,
): Memory[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory
        WHERE pinned = 1 AND scope = @scope
          AND (@scopeRef IS NULL OR scope_ref = @scopeRef)
        ORDER BY path`,
    )
    .all({ scope, scopeRef });
  return rows.map((row) => MemorySchema.parse(row));
}
