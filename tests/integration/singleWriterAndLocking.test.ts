import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { nowIso } from '../../src/shared/models/ids';
import { insertProject } from '../../src/main/db/repositories/projects';
import { insertTask } from '../../src/main/db/repositories/tasks';
import { insertWorktree, acquireWorktreeLease } from '../../src/main/db/repositories/worktrees';
import { installBeginStatementSpy } from '../helpers/beginStatementSpy';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const PROJECT_ID = 'PROJ1'.padEnd(26, '0');

/**
 * AUDIT finding #3 (BLOCKER): the "one write connection" invariant
 * (§5.0, connection.ts's own doc comment) was enforced by nothing — two
 * `openConnection()` calls to the same file both succeeded. Compounding
 * this, the counter-increment and lease-acquisition transactions §5.1.2
 * explicitly requires `BEGIN IMMEDIATE` for used plain deferred `BEGIN`
 * instead.
 */
describe('single-writer enforcement (AUDIT finding #3)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-single-writer-'));
    dbPath = path.join(tmpDir, 'bureau.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses a second connection to a path that is already open', () => {
    const db1 = openConnection(dbPath);
    let db2: Database.Database | undefined;
    try {
      expect(() => {
        db2 = openConnection(dbPath);
      }).toThrow();
    } finally {
      db2?.close();
      db1.close();
    }
  });

  it('allows reopening the same path once the first connection is closed', () => {
    const db1 = openConnection(dbPath);
    db1.close();
    const db2 = openConnection(dbPath);
    db2.close();
  });

  it('allows two different paths to be open at the same time', () => {
    const dbPath2 = path.join(tmpDir, 'other.db');
    const db1 = openConnection(dbPath);
    const db2 = openConnection(dbPath2);
    db1.close();
    db2.close();
  });
});

describe('§5.1.2 BEGIN IMMEDIATE for counter/lease transactions (AUDIT finding #3)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let now: string;
  let spy: ReturnType<typeof installBeginStatementSpy>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-begin-immediate-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    // Must be installed before the very first db.transaction() call of any
    // kind on this connection — see the helper's doc comment.
    spy = installBeginStatementSpy(db);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    spy.reset(); // ignore the migration runner's own (unrelated) transactions
    now = nowIso();

    db.prepare('INSERT INTO projects (id,display_key,name,path,kind,stage,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
      PROJECT_ID, 'P-SEED', 'Test', 'C:\\test', 'software', 'intake', now, now,
    );
    db.prepare('INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(
      'D'.padEnd(26, '0'), 'engineering', 'Engineering', '{}', now, now,
    );
    db.prepare(
      `INSERT INTO roles (id,key,department_key,pack_id,version,title,description,system_prompt_path,skills,deliverable_types,engine_preference,tools_allow,tools_deny,memory_scopes,autonomy_default,sprite_key,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('R'.padEnd(26, '0'), 'developer', 'engineering', 'core', '1.0.0', 'Dev', 'd', 'p.md', '[]', '[]', '[]', '[]', '[]', '[]', 'guided', 'dev', now, now);
    db.prepare(
      'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run('EMP1'.padEnd(26, '0'), 'Ravi', 'core:developer', 0, 0, 'a', 'idle', 'claude-code', 'guided', now, now, now);
  });

  afterEach(() => {
    spy.restore();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insertProject uses BEGIN IMMEDIATE for its counter-increment + row-insert transaction', () => {
    insertProject(db, { name: 'X', path: 'C:\\x', kind: 'software' });
    expect(spy.counts['BEGIN IMMEDIATE']).toBe(1);
    expect(spy.counts['BEGIN']).toBe(0);
  });

  it('insertTask uses BEGIN IMMEDIATE for its counter-increment + row-insert transaction', () => {
    insertTask(db, { project_id: PROJECT_ID, title: 'x', body: 'b', acceptance_criteria: ['x'] });
    expect(spy.counts['BEGIN IMMEDIATE']).toBe(1);
    expect(spy.counts['BEGIN']).toBe(0);
  });

  it('acquireWorktreeLease uses BEGIN IMMEDIATE', () => {
    const wt = insertWorktree(db, { project_id: PROJECT_ID, path: 'C:\\wt\\1', branch: 'b', base_commit: 'c' });
    spy.reset(); // isolate from insertWorktree's own (unrelated) writes
    acquireWorktreeLease(db, wt.id, 'EMP1'.padEnd(26, '0'), new Date(Date.now() + 60_000).toISOString());
    expect(spy.counts['BEGIN IMMEDIATE']).toBe(1);
    expect(spy.counts['BEGIN']).toBe(0);
  });
});
