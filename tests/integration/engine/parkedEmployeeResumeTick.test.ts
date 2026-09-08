import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { nowIso, newId } from '../../../src/shared/models/ids';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee, getEmployeeById } from '../../../src/main/db/repositories/employees';
import {
  promoteResumableParkedEmployees,
  startResumeTick,
} from '../../../src/main/engine/parkedEmployeeResumeTick';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('parkedEmployeeResumeTick (§24.3 — the orchestrator tick, narrowly scoped)', () => {
  let tmpDir: string;
  let activityLogPath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-resume-tick-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    activityLogPath = path.join(tmpDir, 'activity.jsonl');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(activityLogPath, db);
    const now = nowIso();
    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', '{}', now, now);
  });

  afterEach(() => {
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

  function makeParkedEmployee(resumeAt: string | null) {
    const role = insertRole(db, {
      key: `developer-${newId()}`,
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes code',
      system_prompt_path: 'prompts/developer.md',
      skills: ['code'],
      deliverable_types: ['code'],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: ['role'],
      autonomy_default: 'guided',
      sprite_key: 'dev',
    } as never);
    return insertEmployee(db, {
      name: `Emp-${Math.random()}`,
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'parked',
      status_detail: null,
      engine: 'claude-code',
      engine_mode: null,
      engine_version: null,
      model: null,
      session_id: null,
      pid: null,
      process_start_time: null,
      worktree_id: null,
      current_task_id: null,
      autonomy: 'guided',
      daily_budget_usd_micros: null,
      resume_at: resumeAt,
      heartbeat_at: null,
      consecutive_failures: 0,
      lifetime_spend_usd_micros: 0,
    } as never);
  }

  it('promotes a parked employee whose resume_at has already passed to off, clears resume_at, emits employee.resumed', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const employee = makeParkedEmployee(past);

    const promoted = promoteResumableParkedEmployees(db, activityLog);

    expect(promoted).toEqual([employee.id]);
    const row = getEmployeeById(db, employee.id);
    expect(row?.status).toBe('off');
    expect(row?.resume_at).toBeNull();

    const entries = readActivityLogLines() as Array<{ type: string; employee_id: string | null }>;
    const resumedEvent = entries.find(
      (e) => e.type === 'employee.resumed' && e.employee_id === employee.id,
    );
    expect(resumedEvent, JSON.stringify(entries)).toBeDefined();
  });

  it('does not touch a parked employee whose resume_at has not passed yet', () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const employee = makeParkedEmployee(future);

    const promoted = promoteResumableParkedEmployees(db, activityLog);

    expect(promoted).toEqual([]);
    expect(getEmployeeById(db, employee.id)?.status).toBe('parked');
  });

  it('does not touch a parked employee with no resume_at at all (parked for a reason other than a rate limit, e.g. budget)', () => {
    const employee = makeParkedEmployee(null);
    const promoted = promoteResumableParkedEmployees(db, activityLog);
    expect(promoted).toEqual([]);
    expect(getEmployeeById(db, employee.id)?.status).toBe('parked');
  });

  it('startResumeTick runs the promotion on its own interval and stop() halts it', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const employee = makeParkedEmployee(past);

    const handle = startResumeTick(db, activityLog, 20);
    await new Promise((resolve) => setTimeout(resolve, 80));
    handle.stop();

    expect(getEmployeeById(db, employee.id)?.status).toBe('off');

    // After stop(), further parks are not auto-resumed by this handle.
    const another = makeParkedEmployee(new Date(Date.now() - 1000).toISOString());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(getEmployeeById(db, another.id)?.status).toBe('parked');
  });
});
