import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { reconcile } from '../../src/main/db/reconcile';
import { ActivityLog } from '../../src/main/db/activityLog';
import { startTimeOfLiveProcess } from '../helpers/processStartTime';
import { nowIso } from '../../src/shared/models/ids';

/**
 * **The 26-character ids below are load-bearing, not decoration.** Audit
 * M0–M2 #2 made `logEvent` validate its input against
 * `NewEventInputSchema`, whose correlation ids are `IdSchema` — a ULID,
 * exactly 26 characters. These fixtures previously seeded 'co1', 'proj1',
 * 'emp-lease-holder' and friends, which the application itself can never
 * produce, so every event this file drove was carrying ids no production
 * row would have. Padding them is what makes the seeded state a state the
 * app could actually be in. Do not shorten them back.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * AUDIT finding #2 (BLOCKER): `ActivityLog.logEvent()` — the only
 * sanctioned writer of events (CLAUDE.md invariant #3, §5.2/§11.6) — was
 * called by nothing anywhere, including `reconcile()`'s own five
 * behaviors, all of which are real state changes with a documented event
 * type (§5.2's taxonomy: `employee.orphan_killed`, `git.lease_reclaimed`,
 * `task.blocked`, `chat.stream_aborted`, and a summary `app.reconciled`).
 */
describe('reconcile() emits activity events for every state change it makes (AUDIT finding #2)', () => {
  let tmpDir: string;
  let dbPath: string;
  let activityLogPath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let now: string;
  let dummyChild: ChildProcess | undefined;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-reconcile-events-'));
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
    ).run('dept1000000000000000000000', 'engineering', 'Engineering', '{}', now, now);
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
    ).run(
      'proj1000000000000000000000',
      'P-001',
      'Test',
      'C:\\test',
      'software',
      'intake',
      now,
      now,
    );
    db.prepare(
      "INSERT INTO companies (id,name,home_path,director_employee_id,floor_layout,settings,created_at,updated_at) VALUES ('co100000000000000000000000','Test Co','C:\\home',NULL,'{}','{}',?,?)",
    ).run(now, now);
  });

  afterEach(() => {
    dummyChild?.kill();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readActivityLogLines(): unknown[] {
    if (!existsSync(activityLogPath)) return [];
    return readFileSync(activityLogPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown);
  }

  it('emits employee.orphan_killed when the orphan sweep kills a process', async () => {
    dummyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    const pid = dummyChild.pid;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const startTime = startTimeOfLiveProcess(pid as number);

    db.prepare(
      'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,pid,process_start_time,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'emp10000000000000000000000',
      'Quinn',
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

    await reconcile(db, activityLog, tmpDir);

    const entries = readActivityLogLines() as Array<{ type: string; employee_id: string | null }>;
    const orphanEvent = entries.find((e) => e.type === 'employee.orphan_killed');
    expect(
      orphanEvent,
      `expected an employee.orphan_killed entry in activity.jsonl, got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
    expect(orphanEvent?.employee_id).toBe('emp10000000000000000000000');

    const mirrorRow = db
      .prepare("SELECT * FROM events WHERE type = 'employee.orphan_killed'")
      .get();
    expect(mirrorRow, 'expected the events mirror table to also have the row').toBeDefined();
  });

  it('emits git.lease_reclaimed when an expired lease is reclaimed', async () => {
    db.prepare(
      'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'emp-lease00000000000000000',
      'emp-lease00000000000000000',
      'core:developer',
      0,
      0,
      'a',
      'idle',
      'claude-code',
      'guided',
      now,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO worktrees (id,project_id,path,branch,base_commit,lease_holder,lease_expires_at,status,created_at,updated_at) VALUES ('wt100000000000000000000000','proj1000000000000000000000','C:\\wt\\1','b','c','emp-lease00000000000000000',?,'leased',?,?)",
    ).run('2000-01-01T00:00:00.000Z', now, now);

    await reconcile(db, activityLog, tmpDir);

    const entries = readActivityLogLines() as Array<{ type: string }>;
    expect(
      entries.some((e) => e.type === 'git.lease_reclaimed'),
      JSON.stringify(entries),
    ).toBe(true);
  });

  it('emits task.blocked when a running task is blocked on restart', async () => {
    db.prepare(
      "INSERT INTO tasks (id,display_key,project_id,title,body,acceptance_criteria,status,created_at,updated_at) VALUES ('task1000000000000000000000','T-0001','proj1000000000000000000000','t','b','[\"x\"]','running',?,?)",
    ).run(now, now);

    await reconcile(db, activityLog, tmpDir);

    const entries = readActivityLogLines() as Array<{ type: string; task_id: string | null }>;
    const taskEvent = entries.find((e) => e.type === 'task.blocked');
    expect(taskEvent, JSON.stringify(entries)).toBeDefined();
    expect(taskEvent?.task_id).toBe('task1000000000000000000000');
  });

  it('emits chat.stream_aborted when a streaming message is aborted', async () => {
    db.prepare(
      "INSERT INTO conversations (id,company_id,project_id,title,status,created_at,updated_at) VALUES ('conv1000000000000000000000','co100000000000000000000000',NULL,'chat','active',?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO conversation_messages (id,conversation_id,author,kind,body,status,created_at,updated_at) VALUES ('msg10000000000000000000000','conv1000000000000000000000','director','text','partial...','streaming',?,?)",
    ).run(now, now);

    await reconcile(db, activityLog, tmpDir);

    const entries = readActivityLogLines() as Array<{ type: string }>;
    expect(
      entries.some((e) => e.type === 'chat.stream_aborted'),
      JSON.stringify(entries),
    ).toBe(true);
  });

  it('emits control.stale_token_deleted when a stale control.json is swept on startup', async () => {
    const employeeId = 'emp-stale00000000000000000';
    const employeeDir = path.join(tmpDir, 'employees', employeeId);
    mkdirSync(employeeDir, { recursive: true });
    writeFileSync(
      path.join(employeeDir, 'control.json'),
      JSON.stringify({ port: 1, token: 'x', employeeId }),
      'utf8',
    );

    await reconcile(db, activityLog, tmpDir);

    const entries = readActivityLogLines() as Array<{
      type: string;
      employee_id: string | null;
      severity: string;
    }>;
    const staleEvent = entries.find((e) => e.type === 'control.stale_token_deleted');
    expect(staleEvent, JSON.stringify(entries)).toBeDefined();
    expect(staleEvent?.employee_id).toBe(employeeId);
    expect(staleEvent?.severity).toBe('warn');
  });

  it('emits exactly one app.reconciled summary event per reconcile() call, even when nothing else changed', async () => {
    await reconcile(db, activityLog, tmpDir);
    const entries = readActivityLogLines() as Array<{ type: string }>;
    expect(entries.filter((e) => e.type === 'app.reconciled')).toHaveLength(1);
  });
});
