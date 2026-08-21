import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { nowIso } from '../../src/shared/models/ids';
import {
  insertCompany,
  insertEmployee,
  insertCheckpoint,
  insertMemory,
  insertTask,
  insertUsage,
  insertProject,
  upsertPrereq,
} from '../../src/main/db/repositories';
import type { NewTaskInput } from '../../src/shared/models/task';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

// IdSchema requires exactly 26 characters (ULID length) — now genuinely
// enforced end to end since this finding's fix, so fixture ids must be
// real ULID-shaped strings, not short mnemonics.
const PROJECT_ID = 'PROJ1'.padEnd(26, '0');

/**
 * AUDIT finding #1 (BLOCKER): no repository applied its own Zod schema's
 * defaults, or validated its input, before writing. Two distinct failure
 * modes, both covered here:
 *
 *  (a) A caller who relies on a documented default (exactly what
 *      `NewXInputSchema`'s `.default(...)` calls promise) gets a raw
 *      better-sqlite3 crash instead of the default being applied.
 *  (b) A caller who passes a value that violates the schema (e.g. a float
 *      where money must be an integer) gets the bad value **written and
 *      committed**, and only then does the function's own read-back throw
 *      — permanently corrupting that row and, for counter-backed tables,
 *      burning a display-key number with nothing valid behind it.
 */
describe('repository input validation (AUDIT finding #1)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let now: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-repo-validation-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    now = nowIso();

    db.prepare('INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(
      'dept1', 'engineering', 'Engineering', '{}', now, now,
    );
    db.prepare(
      `INSERT INTO roles (id,key,department_key,pack_id,version,title,description,system_prompt_path,skills,deliverable_types,engine_preference,tools_allow,tools_deny,memory_scopes,autonomy_default,sprite_key,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('role1', 'developer', 'engineering', 'core', '1.0.0', 'Dev', 'd', 'p.md', '[]', '[]', '[]', '[]', '[]', '[]', 'guided', 'dev', now, now);
    // display_key is deliberately out of the counter's own P-NNN sequence
    // (which starts fresh at 1 in every new test DB) so it can never
    // collide with a display_key a test generates via insertProject/insertTask.
    db.prepare('INSERT INTO projects (id,display_key,name,path,kind,stage,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
      PROJECT_ID, 'P-SEED', 'Test', 'C:\\test', 'software', 'intake', now, now,
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insertCompany applies documented defaults when the caller omits them', () => {
    const company = insertCompany(db, { name: 'Audit Co', home_path: 'C:\\audit' });
    expect(company.floor_layout).toEqual({});
    expect(company.settings).toEqual({});
  });

  it('insertEmployee applies documented defaults when the caller omits them', () => {
    const employee = insertEmployee(db, {
      name: 'AuditBot',
      role_key: 'core:developer',
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      engine: 'claude-code',
      autonomy: 'guided',
    });
    expect(employee.is_director).toBe(false);
    expect(employee.status).toBe('off');
    expect(employee.consecutive_failures).toBe(0);
    expect(employee.lifetime_spend_usd_micros).toBe(0);
  });

  it('insertCheckpoint applies documented defaults and still enforces its .refine() rule', () => {
    const cp = insertCheckpoint(db, {
      type: 'information',
      urgency: 'whenever',
      title: 'FYI',
      context: 'context',
    });
    expect(cp.status).toBe('pending');
    expect(cp.options).toBeNull();
  });

  it('insertMemory applies documented defaults (tags, pinned) when omitted', () => {
    const mem = insertMemory(db, {
      scope: 'project',
      path: 'memory/x.md',
      title: 't',
      body: 'b',
      content_sha256: 'abc',
      source: 'observed',
    });
    expect(mem.tags).toEqual([]);
    expect(mem.pinned).toBe(false);
  });

  it('insertTask applies documented defaults (status, priority, required_skills) when omitted', () => {
    const task = insertTask(db, {
      project_id: PROJECT_ID,
      title: 'Do the thing',
      body: 'body',
      acceptance_criteria: ['it works'],
    });
    expect(task.status).toBe('queued');
    expect(task.priority).toBe(50);
    expect(task.required_skills).toEqual([]);
    expect(task.display_key).toBe('T-0001');
  });

  // Every field below except the one under test is filled in explicitly
  // and validly — isolating the one deviation is the point. A test that
  // also omits other defaulted fields would throw on those first (better-
  // sqlite3's "invalid type of undefined") and pass for the wrong reason,
  // since that also happens to roll back the same transaction.
  const completeTaskInput: NewTaskInput = {
    project_id: PROJECT_ID,
    phase_id: null,
    parent_task_id: null,
    title: 'x',
    body: 'b',
    acceptance_criteria: ['x'],
    required_skills: [],
    deliverable_type: null,
    assignee_employee_id: null,
    excluded_employees: [],
    status: 'queued',
    status_reason: null,
    priority: 50,
    estimated_cost_usd_micros: null,
  };

  it('insertTask rejects an empty acceptance_criteria array before writing anything or consuming the counter', () => {
    const before = db.prepare("SELECT value FROM counters WHERE name = 'task'").get() as { value: number } | undefined;
    expect(() => insertTask(db, { ...completeTaskInput, acceptance_criteria: [] })).toThrow();
    const after = db.prepare("SELECT value FROM counters WHERE name = 'task'").get() as { value: number } | undefined;
    expect(after?.value ?? 0).toBe(before?.value ?? 0);
    expect(db.prepare('SELECT COUNT(*) as n FROM tasks').get()).toEqual({ n: 0 });
  });

  it('insertTask rejects a non-integer money value before writing anything or consuming the counter — no corrupted row is ever committed', () => {
    const before = db.prepare("SELECT value FROM counters WHERE name = 'task'").get() as { value: number } | undefined;
    expect(() =>
      // deliberately invalid: money must be an integer
      insertTask(db, { ...completeTaskInput, estimated_cost_usd_micros: 19.99 }),
    ).toThrow();
    const after = db.prepare("SELECT value FROM counters WHERE name = 'task'").get() as { value: number } | undefined;
    expect(after?.value ?? 0).toBe(before?.value ?? 0);
    expect(db.prepare('SELECT COUNT(*) as n FROM tasks').get()).toEqual({ n: 0 });
  });

  it('insertUsage rejects a non-integer cost before writing anything — no corrupted, permanently-unreadable row is ever committed', () => {
    expect(() =>
      insertUsage(db, {
        employee_id: null,
        task_id: null,
        engine: 'claude-code',
        model: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
        cost_usd_micros: 0.5, // deliberately invalid: money must be an integer
        turn_index: null,
        source: 'turn',
      }),
    ).toThrow();
    // The bug this guards against: the old code let this INSERT succeed and
    // only threw on the read-back, leaving a row in the table forever that
    // every future read of it (getUsageById, any report) would also throw
    // on. Prove no such row exists.
    expect(db.prepare('SELECT COUNT(*) as n FROM usage').get()).toEqual({ n: 0 });
  });

  it('insertProject applies documented defaults when omitted', () => {
    const project = insertProject(db, { name: 'Second project', path: 'C:\\second', kind: 'software' });
    expect(project.repo_initialised).toBe(false);
    expect(project.base_ref).toBe('main');
    expect(project.protected_refs).toEqual(['main', 'master']);
    expect(project.spend_usd_micros).toBe(0);
    expect(project.display_key).toBe('P-001');
  });

  it('upsertPrereq applies documented defaults when omitted', () => {
    const prereq = upsertPrereq(db, { key: 'git', status: 'found' });
    expect(prereq.version).toBeNull();
    expect(prereq.notes).toBeNull();
  });
});
