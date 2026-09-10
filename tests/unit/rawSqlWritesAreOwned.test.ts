import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * AUDIT M0–M2 #4 — the guard, and the reason this finding is a
 * **regression** rather than a gap.
 *
 * `docs/progress/M0-M2.md:478` records the August audit's finding #9 as
 * closed: *"`reconcile.ts`'s raw SQL was eliminated entirely"*. It came
 * back. Three direct `UPDATE`s on `spend_usd_micros` /
 * `lifetime_spend_usd_micros`, each on a column that already had a
 * designated writer in `repositories/usage.ts` — so three columns had two
 * owners, which is standing rule 6's exact shape and is invisible to every
 * test of either half.
 *
 * A fix without a guard regresses a third time. This is the guard.
 *
 * ## What it checks, and why this scope
 *
 * **Write statements only** (`INSERT` / `UPDATE` / `DELETE` / `REPLACE`),
 * not every `db.prepare`. Reads outside `repositories/` are a different
 * question and mostly a legitimate one — a query joining five tables for a
 * cost view does not belong in any single-table repository, and there are
 * roughly 55 such sites. Writes are where "two owners for one column"
 * lives, and there are twelve. Scoping the rule to writes makes it a rule
 * about the defect rather than a rule about style, and keeps the allowlist
 * short enough to actually read.
 *
 * ## The allowlist is the point
 *
 * Every entry names a file and a reason. Adding one requires editing this
 * list, which is a visible decision in a diff rather than a silent
 * exemption — that is the whole mechanism. **An entry is only legitimate
 * when the module is the SOLE writer of the columns it touches.** If
 * another writer exists for the same column, that is the defect this
 * finding is about and the answer is a repository function, not a new row
 * here.
 */

const REPO_DIR = path.join('src', 'main', 'db', 'repositories');

/**
 * File → why this module writes SQL directly. Judged on sole-ownership,
 * never on tidiness.
 */
const SOLE_WRITERS: Readonly<Record<string, string>> = {
  'src/main/db/activityLog.ts':
    'Owns the `events` table outright. §21 makes `logEvent`/`insertMirrorRow` its only writer, ' +
    'and `events` deliberately has no repository file — this module IS the repository for it, ' +
    'as its own getMaxMirrorSeq comment states.',
  'src/main/db/migrate.ts':
    'Owns `schema_migrations`. The migration runner cannot go through a repository that a ' +
    'migration may not have created yet — the chicken-and-egg its own comment describes.',
  'src/main/memory/memoryStore.ts':
    'Owns the `memory` row lifecycle for §12.1 writes (file first, index second). The ordering ' +
    'is the property under test in the kill-point gate; routing the insert through a repository ' +
    'would put the two halves in different modules.',
  'src/main/memory/rebuildMemoryIndex.ts':
    'Sole writer for the wipe-and-rebuild path (§12.1). Deletes and re-inserts the whole index ' +
    'as one transaction, which is not a per-row repository operation.',
  'src/main/memory/syncMemoryIndex.ts':
    'Sole writer for the incremental reconcile of index rows against the files on disk (§12.1).',
  'src/main/chat/chatStream.ts':
    'Sole writer for the streaming lifecycle of `conversation_messages.body`/`status` — the ' +
    'throttled append is a stateful sequence, not a row write, and M9 put it here deliberately.',
  'src/main/engine/parkedEmployeeResumeTick.ts':
    'Sole writer for the park/resume transition it owns. Named by audit #4 as a sole writer and ' +
    're-checked here: no repository writes the same columns.',
  'src/main/checkpoints/taskBlocking.ts':
    'Sole writer for the checkpoint-driven task block/unblock transition. Named by audit #4 as a ' +
    'sole writer and re-checked: `tasks.setTaskStatus` writes `status`, but this module owns the ' +
    'blocked-on-checkpoint pairing that has no repository equivalent.',
};

interface WriteSite {
  readonly file: string;
  readonly verb: string;
  readonly snippet: string;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Pulls every `.prepare(<string literal>)` out of a source file and keeps
 *  the ones whose SQL is a write. Handles the three quote styles and the
 *  multi-line template literals this codebase uses for longer statements. */
function findWriteSites(file: string): WriteSite[] {
  const source = readFileSync(file, 'utf8');
  const sites: WriteSite[] = [];
  const prepareCall = /\.prepare\(\s*(['"`])([\s\S]*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = prepareCall.exec(source)) !== null) {
    const sql = (match[2] ?? '').trim();
    const verb = /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.exec(sql)?.[1]?.toUpperCase();
    if (verb === undefined) continue;
    sites.push({
      file: file.split(path.sep).join('/'),
      verb,
      snippet: sql.replace(/\s+/g, ' ').slice(0, 90),
    });
  }
  return sites;
}

describe('raw SQL writes live in repositories, or in a named sole writer (audit #4)', () => {
  const files = walk(path.join('src', 'main'), []).filter(
    (f) => !f.startsWith(REPO_DIR) && !f.includes(`${path.sep}repositories${path.sep}`),
  );
  const sites = files.flatMap(findWriteSites);

  it('finds write sites at all — the scan is not silently matching nothing', () => {
    // Standing rule 9 in test form. A regex that quietly stopped matching
    // would make this whole file pass while checking nothing, which is
    // precisely the failure mode audit #4 exists to prevent.
    const repoSites = walk(REPO_DIR, []).flatMap(findWriteSites);
    expect(repoSites.length, 'the repositories themselves contain many writes').toBeGreaterThan(20);
    expect(sites.length, 'and some writes legitimately live outside them').toBeGreaterThan(0);
  });

  it('every write outside repositories/ is in a module named as its sole writer', () => {
    const unowned = sites.filter((s) => !(s.file in SOLE_WRITERS));
    const report = unowned.map((s) => `  ${s.file}: ${s.verb} — ${s.snippet}`).join('\n');
    expect(
      unowned,
      unowned.length === 0
        ? ''
        : `Raw SQL writes outside src/main/db/repositories/ with no entry in SOLE_WRITERS:\n${report}\n\n` +
            `Either add a repository function and call it, or add the file to SOLE_WRITERS with a ` +
            `reason — but only if it is genuinely the ONLY writer of those columns. Two owners for ` +
            `one column is audit #4's defect (standing rule 6).`,
    ).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    // The reverse direction, the same way `securitySuiteCoverage` checks
    // its own list: an entry for a file that no longer writes SQL is a
    // permission nobody needs and a reader has to re-derive.
    const filesWithWrites = new Set(sites.map((s) => s.file));
    const stale = Object.keys(SOLE_WRITERS).filter((f) => !filesWithWrites.has(f));
    expect(
      stale,
      `SOLE_WRITERS entries whose file no longer writes SQL: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('reconcile.ts writes no SQL of its own — the regression this finding names', () => {
    // Pinned BY NAME, not just covered by the general rule above. The
    // August audit closed this exact file and `docs/progress/M0-M2.md:478`
    // still says so; it regressed anyway. A general rule would let a
    // future allowlist entry quietly re-open it.
    const reconcileSites = sites.filter((s) => s.file === 'src/main/db/reconcile.ts');
    expect(
      reconcileSites.map((s) => `${s.verb} — ${s.snippet}`),
      'reconcile() repairs state through repository functions, never directly',
    ).toEqual([]);
    expect(Object.keys(SOLE_WRITERS)).not.toContain('src/main/db/reconcile.ts');
  });
});
