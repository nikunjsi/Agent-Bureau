import path from 'node:path';
import type Database from 'better-sqlite3';

/**
 * White-box verification that a given `db.transaction(...)` call actually
 * used `BEGIN IMMEDIATE` (or whichever variant), not just that *some*
 * transaction ran.
 *
 * better-sqlite3 has no public query-tracing hook, and `transaction.js`
 * calls `this[cppdb].prepare(...)` internally — the *native* binding, not
 * the public `Database.prototype.prepare` — so spying on the public
 * prototype method does not intercept it (confirmed empirically). This
 * reaches through the same private `cppdb` symbol better-sqlite3 itself
 * uses, requiring a direct file path (`node_modules/better-sqlite3/lib/
 * util.js`) since the package's `exports` map blocks the subpath import.
 * It is intentionally scoped to this one test file: it is pinned to
 * better-sqlite3's current internal module layout and would need updating
 * if that ever changes.
 *
 * Must be installed on a **fresh** connection before its first
 * `db.transaction(...)` call of any kind — better-sqlite3 caches one
 * shared controller (and prepares all four BEGIN variants) the first time
 * `.transaction()` is used on a given db, so this needs to see that first
 * call to capture references to the statements it then counts `.run()`
 * calls on.
 */
export function installBeginStatementSpy(db: Database.Database): {
  readonly counts: Readonly<Record<string, number>>;
  readonly restore: () => void;
  /** Zeroes every count seen so far — call after any warm-up transactions
   * (e.g. the migration runner's own) so later assertions only reflect the
   * transaction under test. */
  readonly reset: () => void;
} {
  const mainEntry = require.resolve('better-sqlite3');
  const utilPath = path.join(path.dirname(mainEntry), 'util.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate reach into a private internal, see doc comment above
  const { cppdb } = require(utilPath) as { cppdb: symbol };

  type Internal = { prepare: (...args: unknown[]) => { run: (...args: unknown[]) => unknown } };
  const internal = (db as unknown as Record<symbol, Internal | undefined>)[cppdb];
  if (!internal) {
    throw new Error('better-sqlite3 internal shape changed: db[cppdb] was not found');
  }
  const origPrepare = internal.prepare.bind(internal);
  const counts: Record<string, number> = {};

  internal.prepare = (sql: unknown, ...rest: unknown[]) => {
    const stmt = origPrepare(sql as string, ...rest);
    if (typeof sql === 'string' && sql.startsWith('BEGIN')) {
      counts[sql] = 0;
      const origRun = stmt.run.bind(stmt);
      stmt.run = (...args: unknown[]) => {
        counts[sql] = (counts[sql] ?? 0) + 1;
        return origRun(...args);
      };
    }
    return stmt;
  };

  return {
    counts,
    restore: () => {
      internal.prepare = origPrepare;
    },
    reset: () => {
      for (const key of Object.keys(counts)) counts[key] = 0;
    },
  };
}
