import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { reconcile } from '../../src/main/db/reconcile';
import { ActivityLog } from '../../src/main/db/activityLog';
import { getProcessStartTime } from '../../src/main/process/processInfo';
import { nowIso } from '../../src/shared/models/ids';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('reconcile() (§4.4, §28 M1 step 7)', () => {
  let tmpDir: string;
  let dbPath: string;
  let activityLogPath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
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
    activityLog = ActivityLog.open(activityLogPath, db);
    now = nowIso();

    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', '{}', now, now);
    db.prepare(
      `INSERT INTO roles (id,key,department_key,pack_id,version,title,description,system_prompt_path,skills,deliverable_types,engine_preference,tools_allow,tools_deny,memory_scopes,autonomy_default,sprite_key,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'role1',
      'developer',
      'engineering',
      'core',
      '1.0.0',
      'Dev',
      'd',
      'p.md',
      '[]',
      '[]',
      '[]',
      '[]',
      '[]',
      '[]',
      'guided',
      'dev',
      now,
      now,
    );
    db.prepare(
      'INSERT INTO projects (id,display_key,name,path,kind,stage,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run('proj1', 'P-001', 'Test', 'C:\\test', 'software', 'intake', now, now);
    db.prepare(
      "INSERT INTO companies (id,name,home_path,director_employee_id,floor_layout,settings,created_at,updated_at) VALUES ('co1','Test Co','C:\\home',NULL,'{}','{}',?,?)",
    ).run(now, now);
  });

  afterEach(() => {
    dummyChild?.kill();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('kills an employee process that is still alive with a matching start time (orphan sweep)', async () => {
    dummyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    const pid = dummyChild.pid;
    expect(pid).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 200)); // let it fully start
    const startTime = getProcessStartTime(pid as number);
    expect(startTime).not.toBeNull();

    db.prepare(
      'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,pid,process_start_time,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'emp1',
      'Ravi',
      'core:developer',
      0,
      0,
      'a',
      'working',
      'claude-code',
      pid,
      startTime,
      'guided',
      now,
      now,
      now,
    );

    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.orphansKilled).toEqual(['emp1']);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(getProcessStartTime(pid as number)).toBeNull(); // actually dead now
  });

  it('does not touch an employee whose recorded start time no longer matches (PID reuse guard)', async () => {
    // AUDIT finding #5: the old version of this test used PID 999999,
    // which doesn't exist — it never actually tested reuse (a *different*
    // live process now holding the same PID number a stale row
    // remembers), only "a dead PID is ignored", which sweepOrphans already
    // has to handle trivially (getProcessStartTime returns null for it).
    // This spawns a real, currently-alive process and records a stale
    // process_start_time that does not match its real one — simulating
    // the PID having been reused by an unrelated process since the row
    // was written — then proves the guard leaves it running.
    dummyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    const pid = dummyChild.pid;
    expect(pid).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const realStartTime = getProcessStartTime(pid as number);
    expect(realStartTime).not.toBeNull();

    db.prepare(
      'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,pid,process_start_time,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'emp2',
      'Meera',
      'core:developer',
      0,
      0,
      'a',
      'working',
      'claude-code',
      pid,
      '2000-01-01T00:00:00.000Z',
      'guided',
      now,
      now,
      now,
    );

    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.orphansKilled).toEqual([]);

    // The decisive assertion the old test couldn't make: the process is
    // still genuinely alive — the guard didn't kill a live, unrelated
    // process just because its PID number collided with a stale row.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getProcessStartTime(pid as number)).toBe(realStartTime);
  });

  it('repairs the events mirror from the activity.jsonl tail', async () => {
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

    // Reopen, matching the real sequence: a fresh process's ActivityLog.open()
    // always runs *after* whatever a previous (possibly crashed) process
    // already wrote to the file, so it computes nextSeq from that file's
    // true tail — never before an out-of-band write like this test's own
    // appendFileSync above.
    activityLog.close();
    activityLog = ActivityLog.open(activityLogPath, db);

    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.mirrorRepaired).toBe(1);
    const row = db.prepare('SELECT * FROM events WHERE seq = 1').get() as {
      id: string;
      ts: string;
    };
    expect(row.id).toBe('evt1');
    expect(row.ts).toBe(now);
  });

  function insertTestEmployee(id: string) {
    db.prepare(
      'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, id, 'core:developer', 0, 0, 'a', 'idle', 'claude-code', 'guided', now, now, now);
  }

  it('reclaims an expired worktree lease', async () => {
    insertTestEmployee('emp-lease-holder');
    db.prepare(
      "INSERT INTO worktrees (id,project_id,path,branch,base_commit,lease_holder,lease_expires_at,status,created_at,updated_at) VALUES ('wt1','proj1','C:\\wt\\1','b','c','emp-lease-holder',?,'leased',?,?)",
    ).run('2000-01-01T00:00:00.000Z', now, now); // long expired

    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.leasesReclaimed).toBe(1);
    const row = db
      .prepare('SELECT lease_holder, status FROM worktrees WHERE id = ?')
      .get('wt1') as {
      lease_holder: string | null;
      status: string;
    };
    expect(row.lease_holder).toBeNull();
    expect(row.status).toBe('free');
  });

  it('does not reclaim a lease that has not expired yet', async () => {
    insertTestEmployee('emp-lease-holder-2');
    const future = new Date(Date.now() + 3_600_000).toISOString();
    db.prepare(
      "INSERT INTO worktrees (id,project_id,path,branch,base_commit,lease_holder,lease_expires_at,status,created_at,updated_at) VALUES ('wt2','proj1','C:\\wt\\2','b','c','emp-lease-holder-2',?,'leased',?,?)",
    ).run(future, now, now);

    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.leasesReclaimed).toBe(0);
  });

  it('blocks a task that was still running when the app crashed', async () => {
    db.prepare(
      "INSERT INTO tasks (id,display_key,project_id,title,body,acceptance_criteria,status,created_at,updated_at) VALUES ('task1','T-0001','proj1','t','b','[\"x\"]','running',?,?)",
    ).run(now, now);

    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.tasksBlocked).toEqual(['task1']);
    const row = db.prepare('SELECT status, status_reason FROM tasks WHERE id = ?').get('task1') as {
      status: string;
      status_reason: string;
    };
    expect(row.status).toBe('blocked');
    expect(row.status_reason).toBe('app_restart');
  });

  it('aborts a conversation message still streaming from before the app started (§5.1 Streaming MUST)', async () => {
    db.prepare(
      "INSERT INTO conversations (id,company_id,project_id,title,status,created_at,updated_at) VALUES ('conv1','co1',NULL,'chat','active',?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO conversation_messages (id,conversation_id,author,kind,body,status,created_at,updated_at) VALUES ('msg1','conv1','director','text','partial...','streaming',?,?)",
    ).run(now, now);

    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.streamingMessagesAborted).toBe(1);
    const row = db.prepare('SELECT status FROM conversation_messages WHERE id = ?').get('msg1') as {
      status: string;
    };
    expect(row.status).toBe('aborted');
  });

  it('deletes a stale control.json left on disk from a previous process life (§7.10)', async () => {
    const employeeId = 'emp-with-stale-token';
    const employeeDir = path.join(tmpDir, 'employees', employeeId);
    mkdirSync(employeeDir, { recursive: true });
    const controlJsonPath = path.join(employeeDir, 'control.json');
    writeFileSync(controlJsonPath, JSON.stringify({ port: 1, token: 'stale', employeeId }), 'utf8');

    const report = await reconcile(db, activityLog, tmpDir);

    expect(report.staleControlJsonDeleted).toEqual([employeeId]);
    expect(existsSync(controlJsonPath)).toBe(false);
  });

  it('does not touch an employee directory that never had a control.json', async () => {
    const employeeId = 'emp-clean';
    mkdirSync(path.join(tmpDir, 'employees', employeeId), { recursive: true });

    const report = await reconcile(db, activityLog, tmpDir);

    expect(report.staleControlJsonDeleted).toEqual([]);
  });

  it('does nothing (and does not throw) when no employees/ directory exists yet', async () => {
    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.staleControlJsonDeleted).toEqual([]);
  });
});
