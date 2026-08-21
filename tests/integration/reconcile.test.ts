import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { reconcile } from '../../src/main/db/reconcile';
import { getProcessStartTime } from '../../src/main/process/processInfo';
import { nowIso } from '../../src/shared/models/ids';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('reconcile() (§4.4, §28 M1 step 7)', () => {
  let tmpDir: string;
  let dbPath: string;
  let activityLogPath: string;
  let db: Database.Database;
  let now: string;
  let dummyChild: ChildProcess | undefined;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-reconcile-'));
    dbPath = path.join(tmpDir, 'bureau.db');
    activityLogPath = path.join(tmpDir, 'activity.jsonl');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    now = nowIso();

    db.prepare('INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(
      'dept1', 'engineering', 'Engineering', '{}', now, now,
    );
    db.prepare(
      `INSERT INTO roles (id,key,department_key,pack_id,version,title,description,system_prompt_path,skills,deliverable_types,engine_preference,tools_allow,tools_deny,memory_scopes,autonomy_default,sprite_key,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('role1', 'developer', 'engineering', 'core', '1.0.0', 'Dev', 'd', 'p.md', '[]', '[]', '[]', '[]', '[]', '[]', 'guided', 'dev', now, now);
    db.prepare('INSERT INTO projects (id,display_key,name,path,kind,stage,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
      'proj1', 'P-001', 'Test', 'C:\\test', 'software', 'intake', now, now,
    );
    db.prepare(
      "INSERT INTO companies (id,name,home_path,director_employee_id,floor_layout,settings,created_at,updated_at) VALUES ('co1','Test Co','C:\\home',NULL,'{}','{}',?,?)",
    ).run(now, now);
  });

  afterEach(() => {
    dummyChild?.kill();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('kills an employee process that is still alive with a matching start time (orphan sweep)', async () => {
    dummyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    const pid = dummyChild.pid;
    expect(pid).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 200)); // let it fully start
    const startTime = getProcessStartTime(pid as number);
    expect(startTime).not.toBeNull();

    db.prepare(
      'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,pid,process_start_time,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run('emp1', 'Ravi', 'core:developer', 0, 0, 'a', 'working', 'claude-code', pid, startTime, 'guided', now, now, now);

    const report = reconcile(db, activityLogPath);
    expect(report.orphansKilled).toEqual(['emp1']);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(getProcessStartTime(pid as number)).toBeNull(); // actually dead now
  });

  it('does not touch an employee whose recorded start time no longer matches (PID reuse guard)', () => {
    db.prepare(
      'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,pid,process_start_time,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run('emp2', 'Meera', 'core:developer', 0, 0, 'a', 'working', 'claude-code', 999999, '2000-01-01T00:00:00.000Z', 'guided', now, now, now);

    const report = reconcile(db, activityLogPath);
    expect(report.orphansKilled).toEqual([]);
  });

  it('repairs the events mirror from the activity.jsonl tail', () => {
    const entry = {
      seq: 1,
      id: 'evt1',
      ts: now,
      actor: 'director',
      type: 'task.completed',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: null,
    };
    appendFileSync(activityLogPath, `${JSON.stringify(entry)}\n`);
    expect(db.prepare('SELECT COUNT(*) as n FROM events').get()).toEqual({ n: 0 });

    const report = reconcile(db, activityLogPath);
    expect(report.mirrorRepaired).toBe(1);
    const row = db.prepare('SELECT * FROM events WHERE seq = 1').get() as { id: string; ts: string };
    expect(row.id).toBe('evt1');
    expect(row.ts).toBe(now);
  });

  function insertTestEmployee(id: string) {
    db.prepare(
      'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, id, 'core:developer', 0, 0, 'a', 'idle', 'claude-code', 'guided', now, now, now);
  }

  it('reclaims an expired worktree lease', () => {
    insertTestEmployee('emp-lease-holder');
    db.prepare(
      "INSERT INTO worktrees (id,project_id,path,branch,base_commit,lease_holder,lease_expires_at,status,created_at,updated_at) VALUES ('wt1','proj1','C:\\wt\\1','b','c','emp-lease-holder',?,'leased',?,?)",
    ).run('2000-01-01T00:00:00.000Z', now, now); // long expired

    const report = reconcile(db, activityLogPath);
    expect(report.leasesReclaimed).toBe(1);
    const row = db.prepare('SELECT lease_holder, status FROM worktrees WHERE id = ?').get('wt1') as {
      lease_holder: string | null;
      status: string;
    };
    expect(row.lease_holder).toBeNull();
    expect(row.status).toBe('free');
  });

  it('does not reclaim a lease that has not expired yet', () => {
    insertTestEmployee('emp-lease-holder-2');
    const future = new Date(Date.now() + 3_600_000).toISOString();
    db.prepare(
      "INSERT INTO worktrees (id,project_id,path,branch,base_commit,lease_holder,lease_expires_at,status,created_at,updated_at) VALUES ('wt2','proj1','C:\\wt\\2','b','c','emp-lease-holder-2',?,'leased',?,?)",
    ).run(future, now, now);

    const report = reconcile(db, activityLogPath);
    expect(report.leasesReclaimed).toBe(0);
  });

  it('blocks a task that was still running when the app crashed', () => {
    db.prepare(
      "INSERT INTO tasks (id,display_key,project_id,title,body,acceptance_criteria,status,created_at,updated_at) VALUES ('task1','T-0001','proj1','t','b','[\"x\"]','running',?,?)",
    ).run(now, now);

    const report = reconcile(db, activityLogPath);
    expect(report.tasksBlocked).toEqual(['task1']);
    const row = db.prepare('SELECT status, status_reason FROM tasks WHERE id = ?').get('task1') as {
      status: string;
      status_reason: string;
    };
    expect(row.status).toBe('blocked');
    expect(row.status_reason).toBe('app_restart');
  });

  it('aborts a conversation message still streaming from before the app started (§5.1 Streaming MUST)', () => {
    db.prepare(
      "INSERT INTO conversations (id,company_id,project_id,title,status,created_at,updated_at) VALUES ('conv1','co1',NULL,'chat','active',?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO conversation_messages (id,conversation_id,author,kind,body,status,created_at,updated_at) VALUES ('msg1','conv1','director','text','partial...','streaming',?,?)",
    ).run(now, now);

    const report = reconcile(db, activityLogPath);
    expect(report.streamingMessagesAborted).toBe(1);
    const row = db.prepare('SELECT status FROM conversation_messages WHERE id = ?').get('msg1') as {
      status: string;
    };
    expect(row.status).toBe('aborted');
  });
});
