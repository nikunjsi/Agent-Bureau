import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { isKnownSender, registerWindow } from '../../src/main/windowRegistry';
import { seedEmployee, seedProject, seedWorktree } from '../helpers/dbFixtures';
import { nowIso } from '../../src/shared/models/ids';

/**
 * # Configuration is in force
 *
 * **The class of gap this file exists to close.** Audit M0–M2's Phase 3
 * broke this code in eighteen ways; eleven were caught and six survived,
 * and the six were not scattered. Every one of them was a **declaration
 * rather than a behaviour** — a pragma, a compiler flag, a partial unique
 * index, an `fsync`, a function whose result is injected into its caller
 * as a boolean. The suite is strong wherever a test can call something and
 * assert on what comes back, and it was blind wherever correctness rests
 * on a setting simply *being set*. Nothing in the repository asserted that
 * a configuration was in force.
 *
 * That blindness is worse than an ordinary missing test, because turning a
 * safety setting OFF is almost always **strictly more permissive**: no
 * existing code can fail, so a green CI is not evidence of anything. The
 * damage never appears in the diff that removes the setting. It appears in
 * everything written afterwards.
 *
 * **If you add a pragma, a compiler flag, an index whose job is to refuse
 * a write, or a security-relevant Electron flag — assert it here.** Then
 * delete it locally and confirm this file goes red. A test that asserts a
 * configuration and does not fail when the configuration changes is
 * precisely the thing this file exists to prevent.
 *
 * Closes audit M0–M2 findings #5, #13, #14 and #15. Two siblings cover the
 * same class where this file's runner cannot reach:
 * `activityLogFsyncOrdering.test.ts` (#8, needs a `node:fs` module mock)
 * and `tests/e2e/security/s13WebPreferences.spec.ts` (#12, needs the real
 * packaged main process).
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('configuration is in force', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-config-in-force-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Audit #13. Asserted against a real connection opened by the real
   * `openConnection`, not by reading the source.
   *
   * Two of these were doing nothing at all before this test existed:
   *
   * - **`foreign_keys` was inert.** `better-sqlite3` already defaults it
   *   ON, so removing §5.0's line changed no observable behaviour and no
   *   test. Referential integrity across all 26 tables rested on an
   *   undocumented library default rather than on anything Bureau wrote.
   * - **`journal_mode = WAL` was unasserted**, and removing it (SQLite's
   *   default is `delete`) left 34 tests green across `killPoints`,
   *   `singleWriterAndLocking` and `migrate` — while `backup.ts` and
   *   `migrate.ts` both contain reasoning that assumes WAL is on.
   *
   * `synchronous` is asserted here for a third reason. §5.0 did not name
   * it, so it ran at whatever SQLite happened to default to. That value is
   * `FULL`, which is the value Bureau wants — but "the value we want,
   * by luck" is exactly the `foreign_keys` situation, and it is load-
   * bearing for §11.6: at `NORMAL`, WAL does not fsync the WAL on commit,
   * and a committed row can be lost to machine death. It is now set
   * explicitly and named in §5.0.
   */
  describe('§5.0 pragmas', () => {
    const EXPECTED: ReadonlyArray<readonly [string, number | string]> = [
      ['foreign_keys', 1],
      ['journal_mode', 'wal'],
      ['busy_timeout', 5000],
      ['synchronous', 2], // 2 = FULL
    ];

    for (const [pragma, expected] of EXPECTED) {
      it(`${pragma} is ${String(expected)} on a real connection`, () => {
        expect(db.pragma(pragma, { simple: true })).toBe(expected);
      });
    }
  });

  /**
   * Audit #14. `leaseAcquire.test.ts` stayed green with this index
   * dropped — *including* the case titled "N concurrent acquirers racing
   * for one free worktree — exactly one ever wins", because what
   * serialises that race is `acquireWorktreeLease`'s `BEGIN IMMEDIATE`,
   * not the index. Two independent defences, and only one was under test.
   *
   * So this asserts the constraint itself, with raw `UPDATE`s that never
   * touch the repository — because the writer this index exists to stop is
   * precisely the one that does not go through the repository, and audit
   * #4 shows those are not hypothetical here.
   */
  describe('§5.1 partial unique index on worktrees.lease_holder', () => {
    it('refuses a second worktree leased to the same employee', () => {
      const project = seedProject(db);
      const employee = seedEmployee(db);
      const first = seedWorktree(db, { project_id: project.id });
      const second = seedWorktree(db, { project_id: project.id });

      const lease = db.prepare(
        'UPDATE worktrees SET lease_holder = ?, updated_at = ? WHERE id = ?',
      );
      lease.run(employee.id, nowIso(), first.id);

      expect(() => lease.run(employee.id, nowIso(), second.id)).toThrow(/UNIQUE constraint failed/);
    });

    it('still allows many worktrees to hold no lease at all — the index is partial', () => {
      const project = seedProject(db);
      seedWorktree(db, { project_id: project.id });
      seedWorktree(db, { project_id: project.id });

      const unleased = db
        .prepare('SELECT COUNT(*) AS n FROM worktrees WHERE lease_holder IS NULL')
        .get() as { n: number };
      expect(unleased.n).toBe(2);
    });

    it('releasing a lease frees the employee to hold another', () => {
      const project = seedProject(db);
      const employee = seedEmployee(db);
      const first = seedWorktree(db, { project_id: project.id });
      const second = seedWorktree(db, { project_id: project.id });

      const lease = db.prepare(
        'UPDATE worktrees SET lease_holder = ?, updated_at = ? WHERE id = ?',
      );
      lease.run(employee.id, nowIso(), first.id);
      lease.run(null, nowIso(), first.id);

      expect(() => lease.run(employee.id, nowIso(), second.id)).not.toThrow();
    });
  });
});

/**
 * Audit #15. `noUncheckedIndexedAccess` could be turned off with typecheck,
 * eslint and the entire unit suite green — the textbook shape of this whole
 * file's problem, since relaxing a compiler flag cannot break code that
 * already compiles under the stricter one.
 *
 * `tsconfig.base.json` holds one definition and all five projects extend
 * it, so asserting it here asserts it everywhere. §28 M0 item 2 names the
 * first two by hand; the rest are the strictness this codebase was written
 * against and would silently stop being enforced the same way.
 */
describe('§28 M0 item 2 — the compiler flags the codebase is written against', () => {
  const REQUIRED_TRUE = [
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noImplicitOverride',
    'noFallthroughCasesInSwitch',
    'noUnusedLocals',
    'noUnusedParameters',
  ] as const;

  const base = JSON.parse(readFileSync(path.resolve('tsconfig.base.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
  };

  for (const flag of REQUIRED_TRUE) {
    it(`${flag} is on in tsconfig.base.json`, () => {
      expect(base.compilerOptions[flag]).toBe(true);
    });
  }
});

/**
 * Audit #5. `isKnownSender()` is the one gate between any `webContents`
 * and all 109 IPC handlers, and it had zero coverage of any kind: mutated
 * to `return true`, 613 unit tests, all of `tests/integration/ipc/` and
 * `liveCheckpointPatch` stayed green.
 *
 * The reason the existing tests could not see it is worth keeping in mind
 * when writing the next one of these. `router.ts` injects the *boolean*
 * for testability and the only test passes `false` in directly, so it
 * exercises the router's branch and never the function that computes it.
 * S13/S14 cannot help either: they send from a genuine window, where
 * `return true` is the correct answer anyway. **The injection is
 * deliberate and stays** — this tests the other half.
 *
 * `windowRegistry.ts` imports only *types* from Electron, so this runs it
 * for real rather than against a re-implementation; the windows are stand-
 * ins for Electron's objects, exercising the two fields the function
 * actually reads.
 */
describe('§17.2 isKnownSender — the gate in front of all 109 handlers', () => {
  interface FakeWindow {
    readonly webContents: { readonly id: number };
    isDestroyed(): boolean;
    once(event: string, cb: () => void): void;
  }

  let nextId = 1000;

  function fakeWindow(): FakeWindow & { destroy(): void; fireClosed(): void } {
    let destroyed = false;
    let onClosed: (() => void) | undefined;
    return {
      webContents: { id: nextId++ },
      isDestroyed: () => destroyed,
      once: (event, cb) => {
        if (event === 'closed') onClosed = cb;
      },
      destroy: () => {
        destroyed = true;
      },
      fireClosed: () => onClosed?.(),
    };
  }

  const asWindow = (w: FakeWindow): BrowserWindow => w as unknown as BrowserWindow;

  it('accepts the webContents of a window Bureau registered', () => {
    const win = fakeWindow();
    registerWindow(asWindow(win));
    expect(isKnownSender(win.webContents as never)).toBe(true);
  });

  it('rejects a webContents that belongs to no registered window', () => {
    // This is the assertion that mutation 9b (`return true`) survived.
    const stranger = fakeWindow();
    expect(isKnownSender(stranger.webContents as never)).toBe(false);
  });

  it('rejects a registered window that has since been destroyed', () => {
    const win = fakeWindow();
    registerWindow(asWindow(win));
    expect(isKnownSender(win.webContents as never)).toBe(true);

    win.destroy();
    expect(isKnownSender(win.webContents as never)).toBe(false);
  });

  it('rejects a window that has been closed and deregistered', () => {
    const win = fakeWindow();
    registerWindow(asWindow(win));
    win.fireClosed();
    expect(isKnownSender(win.webContents as never)).toBe(false);
  });

  it('accepts one registered window without accepting its neighbour', () => {
    // A blanket `return true` passes every test above that expects true.
    // Only a case where two windows differ in status distinguishes "this
    // sender is known" from "some window exists".
    const known = fakeWindow();
    const unknown = fakeWindow();
    registerWindow(asWindow(known));

    expect(isKnownSender(known.webContents as never)).toBe(true);
    expect(isKnownSender(unknown.webContents as never)).toBe(false);
  });
});

describe('N-15: the eslint rules the codebase is written against are in force', () => {
  // The lint half of Pattern D. Turning `no-explicit-any` off leaves
  // `eslint .` green (there is no `any` to report), so only an assertion on
  // the RESOLVED config, for a real file in each area, can notice. Loaded
  // through ESLint's own resolver, so an override added later that switches
  // a rule off for one directory is caught for that directory.
  const SEVERITY_ERROR = 2;
  const cases: Array<{ file: string; rules: string[] }> = [
    {
      file: 'src/main/index.ts',
      rules: ['@typescript-eslint/no-explicit-any', '@typescript-eslint/no-unused-vars'],
    },
    {
      file: 'src/shared/policy/evaluator.ts',
      rules: ['@typescript-eslint/no-explicit-any', '@typescript-eslint/no-unused-vars'],
    },
    {
      file: 'src/renderer/src/App.tsx',
      rules: [
        '@typescript-eslint/no-explicit-any',
        '@typescript-eslint/no-unused-vars',
        'react-hooks/rules-of-hooks',
      ],
    },
    { file: 'src/preload/index.ts', rules: ['@typescript-eslint/no-explicit-any'] },
    { file: 'resources/bin/bureau-hook.ts', rules: ['@typescript-eslint/no-explicit-any'] },
    { file: 'tests/unit/health.test.ts', rules: ['@typescript-eslint/no-explicit-any'] },
  ];

  it.each(cases.flatMap(({ file, rules }) => rules.map((rule) => [file, rule] as const)))(
    '%s: %s is error',
    async (file, rule) => {
      expect(existsSync(path.resolve(file)), `${file} must be a real file`).toBe(true);
      const { ESLint } = await import('eslint');
      const eslint = new ESLint({ cwd: path.resolve('.') });
      const config = (await eslint.calculateConfigForFile(path.resolve(file))) as {
        rules?: Record<string, unknown>;
      };
      const setting = config.rules?.[rule];
      const severity = Array.isArray(setting) ? setting[0] : setting;
      expect(severity, `${rule} for ${file}: ${JSON.stringify(setting)}`).toBe(SEVERITY_ERROR);
    },
  );
});
