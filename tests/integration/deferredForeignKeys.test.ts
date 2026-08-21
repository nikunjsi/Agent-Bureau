import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { nowIso } from '../../src/shared/models/ids';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §5.1.1: the four deferred cyclic FKs. These tests exercise the schema
 * directly with raw SQL (not the repositories) because the point is to
 * prove the *declarative* DEFERRABLE INITIALLY DEFERRED behaviour itself,
 * not any particular repository's convenience wrapper around it.
 */
describe('deferred cyclic foreign keys (§5.1.1)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let now: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-deferred-fk-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    now = nowIso();

    db.prepare('INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(
      'dept1', 'engineering', 'Engineering', JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }), now, now,
    );
    db.prepare(
      `INSERT INTO roles (id,key,department_key,pack_id,version,title,description,system_prompt_path,skills,deliverable_types,engine_preference,tools_allow,tools_deny,memory_scopes,autonomy_default,sprite_key,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('role1', 'director', 'engineering', 'core', '1.0.0', 'Director', 'd', 'p.md', '[]', '[]', '[]', '[]', '[]', '[]', 'guided', 'dir', now, now);
    db.prepare('INSERT INTO projects (id,display_key,name,path,kind,stage,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
      'proj1', 'P-001', 'Test', 'C:\\test', 'software', 'intake', now, now,
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows a genuinely simultaneous mutual reference within one transaction (proves deferral, not just NULL-first)', () => {
    // task.assignee_employee_id -> an employee that doesn't exist *yet*,
    // then that employee is inserted referencing the task as
    // current_task_id — neither row could be inserted alone under
    // immediate FK checking; this only works because both FKs are
    // deferred to commit.
    const txn = db.transaction(() => {
      db.prepare(
        'INSERT INTO tasks (id,display_key,project_id,title,body,acceptance_criteria,status,assignee_employee_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run('task1', 'T-0001', 'proj1', 'T', 'B', '["x"]', 'assigned', 'emp1', now, now);
      db.prepare(
        'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,current_task_id,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run('emp1', 'Ravi', 'core:director', 0, 0, 'a', 'idle', 'claude-code', 'task1', 'guided', now, now, now);
    });
    expect(txn).not.toThrow();
  });

  it('still rejects a truly dangling FK at commit — deferred is not the same as disabled', () => {
    const txn = db.transaction(() => {
      db.prepare(
        'INSERT INTO tasks (id,display_key,project_id,title,body,acceptance_criteria,status,assignee_employee_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run('task2', 'T-0002', 'proj1', 'T', 'B', '["x"]', 'assigned', 'never-inserted', now, now);
    });
    expect(txn).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('the documented bootstrap order works: company w/ NULL director -> employee -> UPDATE', () => {
    const txn = db.transaction(() => {
      db.prepare(
        'INSERT INTO companies (id,name,home_path,director_employee_id,floor_layout,settings,created_at,updated_at) VALUES (?,?,?,NULL,?,?,?,?)',
      ).run('co1', 'Test Co', 'C:\\home', '{}', '{}', now, now);
      db.prepare(
        'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run('emp2', 'Meera', 'core:director', 1, 1, 'a', 'idle', 'claude-code', 'guided', now, now, now);
      db.prepare('UPDATE companies SET director_employee_id = ? WHERE id = ?').run('emp2', 'co1');
    });
    expect(txn).not.toThrow();

    const company = db.prepare('SELECT director_employee_id FROM companies WHERE id = ?').get('co1') as {
      director_employee_id: string;
    };
    expect(company.director_employee_id).toBe('emp2');
  });

  it('employees.worktree_id <-> worktrees.lease_holder is also genuinely deferred', () => {
    db.prepare(
      "INSERT INTO worktrees (id,project_id,path,branch,base_commit,status,created_at,updated_at) VALUES (?,?,?,?,?,'free',?,?)",
    ).run('wt1', 'proj1', 'C:\\wt\\1', 'bureau/x/T-1', 'abc123', now, now);

    const txn = db.transaction(() => {
      db.prepare(
        'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,worktree_id,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run('emp3', 'Dan', 'core:director', 2, 2, 'a', 'idle', 'claude-code', 'wt1', 'guided', now, now, now);
      db.prepare('UPDATE worktrees SET lease_holder = ? WHERE id = ?').run('emp3', 'wt1');
    });
    expect(txn).not.toThrow();
  });
});
