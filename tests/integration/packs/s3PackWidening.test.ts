import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { installPack } from '../../../src/main/packs/installPack';
import { listPacks } from '../../../src/main/db/repositories/packs';
import { writePack, validRoleYaml, APP_VERSION_FOR_TESTS } from '../../helpers/packFixture';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * **S3** (§11.7): "A pack attempting to allow an immutable deny fails
 * validation at LOAD, not at evaluation time."
 *
 * S3 lived in `tests/unit/policy/ruleLoader.test.ts` from M6 until M7,
 * against a hand-built `Rule[]` — the closest thing to a pack that existed
 * before a pack loader did. It lives here now because "a PACK attempting
 * to allow an immutable deny" is the claim, and the only way to make that
 * claim honestly is to write a real pack directory to disk and drive it
 * through the real `loadPack` → `validatePack` → `installPack` chain, into
 * a real migrated database.
 *
 * `package.json`'s `test:security` list is updated in the same commit as
 * this move, and `tests/unit/securitySuiteCoverage.test.ts` exists so the
 * next such move fails loudly instead of silently dropping an S-number
 * from the suite.
 *
 * Every assertion below runs against production code. Nothing here
 * re-implements the loader, the validator, or the rule builder.
 */
describe('S3 — a pack that widens an immutable deny fails at load, and lands nothing', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let baseDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-s3-pack-'));
    baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function install(sourceDir: string) {
    return installPack({
      db,
      activityLog,
      baseDir,
      sourceDir,
      origin: 'user',
      appVersion: APP_VERSION_FOR_TESTS,
    });
  }

  function packDir(name: string): string {
    return path.join(tmpDir, name);
  }

  it('rejects a pack whose role allows committing, naming the pattern and the rule', () => {
    const source = writePack(packDir('git'), {
      roles: [validRoleYaml({ tools_allow: ['Read(**)', 'Bash(npm *|git commit -m *)'] })],
    });

    const result = install(source);

    expect(result.installed).toBe(false);
    const joined = result.errors.join('\n');
    expect(joined).toContain('deny.git_write');
    expect(joined).toContain('git commit -m *');
    expect(joined).toContain('roles/developer.yaml');
  });

  it('rejects a pack whose role reaches outside the worktree to the project checkout', () => {
    const source = writePack(packDir('project'), {
      roles: [validRoleYaml({ tools_allow: ['Write(${project}/**)'] })],
    });

    const result = install(source);

    expect(result.installed).toBe(false);
    expect(result.errors.join('\n')).toContain('deny.write_outside_worktree');
  });

  it('rejects a pack whose role allows sub-agent spawning under its own MCP name', () => {
    const source = writePack(packDir('spawn'), {
      roles: [validRoleYaml({ tools_allow: ['Read(**)', 'mcp__mypack__spawn_worker'] })],
    });

    expect(install(source).errors.join('\n')).toContain('deny.subagent_spawn');
  });

  it('rejects a pack naming a reserved bureau_ tool (AUDIT #10)', () => {
    // §23.2's "Bureau's own tools are always allowed" short-circuit trusts
    // a name prefix ahead of the whole rule scan. A pack may not name one.
    const source = writePack(packDir('reserved'), {
      roles: [validRoleYaml({ tools_allow: ['Read(**)', 'bureau_task_done'] })],
    });

    const joined = install(source).errors.join('\n');
    expect(joined).toContain('reserved');
    expect(joined).toContain('bureau_task_done');
  });

  it('lands NOTHING when one role of four is broken — not three', () => {
    // The literal §6.7 claim: "never partially loaded." Three good roles
    // and one widening role must produce zero rows, which is the case a
    // transaction alone would not catch (nothing in SQLite objects to
    // three valid inserts).
    const source = writePack(packDir('mixed'), {
      roles: [
        validRoleYaml({ key: 'architect', sprite_key: 'architect' }),
        validRoleYaml({ key: 'developer' }),
        validRoleYaml({ key: 'tester', sprite_key: 'tester' }),
        validRoleYaml({ key: 'devops', sprite_key: 'devops', tools_allow: ['Bash(git push *)'] }),
      ],
    });

    const result = install(source);

    expect(result.installed).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM departments').get()).toEqual({ n: 0 });
    expect(listPacks(db)).toEqual([]);
  });

  it('installs a pack whose patterns are broad but not aimed at forbidden ground', () => {
    // The other half of the claim, and the one that makes the rejections
    // above meaningful: §6.5's own reference `tools_allow` must install.
    // Without this, a validator that rejected everything would pass every
    // test above.
    const source = writePack(packDir('good'));

    const result = install(source);

    expect(result.errors).toEqual([]);
    expect(result.installed).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 1 });
    expect(listPacks(db)).toHaveLength(1);
  });

  it('emits exactly one activity event for the install, and none for a rejection', () => {
    const rejected = writePack(packDir('rejected'), {
      roles: [validRoleYaml({ tools_allow: ['Bash(git commit *)'] })],
    });
    install(rejected);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'company.%'").get()).toEqual({ n: 0 });

    install(writePack(packDir('accepted')));
    const rows = db.prepare("SELECT type FROM events WHERE type LIKE 'company.%'").all() as { type: string }[];
    expect(rows).toEqual([{ type: 'company.pack_installed' }]);
  });
});
