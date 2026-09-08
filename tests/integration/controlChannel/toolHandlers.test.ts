import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { insertRole } from '../../../src/main/db/repositories/roles';
import {
  insertEmployee,
  setEmployeeCurrentTask,
  getEmployeeById,
} from '../../../src/main/db/repositories/employees';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertTask, getTaskById } from '../../../src/main/db/repositories/tasks';
import { newId, nowIso } from '../../../src/shared/models/ids';
import type { Supervisor } from '../../../src/main/engine/supervisor';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

function rawPost(
  port: number,
  urlPath: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: urlPath,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : null });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * §7.9's eight employee tools, exercised through the real HTTP server (not
 * calling the handler functions directly) so auth/idempotency/rate-limiting
 * are always genuinely in the loop, matching how bureau-tools will call
 * them for real (M4 session 2).
 */
describe('the eight employee tool handlers, real, over the real control channel (§7.9)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let tokenRegistry: TokenRegistry;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-toolhandlers-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    const now = nowIso();
    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', '{}', now, now);
    tokenRegistry = new TokenRegistry();
    supervisorRegistry = new SupervisorRegistry();
    server = new ControlChannelServer({ db, activityLog, tokenRegistry, supervisorRegistry });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRole() {
    return insertRole(db, {
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
  }

  function makeEmployeeWithTask(overrides: { taskAssignee?: 'self' | 'other' } = {}) {
    const role = makeRole();
    const employee = insertEmployee(db, {
      name: `emp-${newId()}`,
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'working',
      engine: 'claude-code',
      autonomy: 'guided',
    } as never);
    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'A task',
      body: 'Do it.',
      acceptance_criteria: ['done'],
    });
    if (overrides.taskAssignee !== undefined) {
      db.prepare('UPDATE tasks SET assignee_employee_id = ? WHERE id = ?').run(
        employee.id,
        task.id,
      );
      setEmployeeCurrentTask(db, employee.id, task.id);
    }
    const token = tokenRegistry.mint(employee.id);
    return { role, employee, project, task, token };
  }

  function readEventTypes(): string[] {
    return (
      db.prepare('SELECT type FROM events ORDER BY seq').all() as Array<{ type: string }>
    ).map((r) => r.type);
  }

  // ---- bureau_report_status ----

  it("bureau_report_status sets status_detail on the caller's own row", async () => {
    const { employee, token } = makeEmployeeWithTask();
    const res = await rawPost(port, '/v1/tool/bureau_report_status', token, {
      idempotencyKey: 'k1',
      args: { status_detail: 'writing tests' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(getEmployeeById(db, employee.id)?.status_detail).toBe('writing tests');
    expect(readEventTypes()).toContain('employee.status_reported');
  });

  it('rejects a status_detail over 120 chars with a specific, correctable message', async () => {
    const { token } = makeEmployeeWithTask();
    const res = await rawPost(port, '/v1/tool/bureau_report_status', token, {
      idempotencyKey: 'k1',
      args: { status_detail: 'x'.repeat(200) },
    });
    const body = res.body as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toMatch(/status_detail/);
  });

  it('rejects a call missing a required field with a message specific enough to correct the next call (deliberately malformed)', async () => {
    const { token } = makeEmployeeWithTask();
    const res = await rawPost(port, '/v1/tool/bureau_report_status', token, {
      idempotencyKey: 'k1',
      args: {},
    });
    const body = res.body as { ok: boolean; error: { code: string; message: string } };
    expect(res.status).toBe(200); // the envelope carries ok:false; transport itself succeeded — distinguishable from a transport failure
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toMatch(/status_detail/);
  });

  // ---- bureau_task_done ----

  it('bureau_task_done: FULL — task -> review, result_summary set, artifacts written, supervisor notified', async () => {
    const { employee, task, token } = makeEmployeeWithTask({ taskAssignee: 'self' });
    const notedTaskIds: string[] = [];
    const fakeSupervisor = {
      noteTaskDone: (taskId: string) => notedTaskIds.push(taskId),
    } as unknown as Supervisor;
    supervisorRegistry.register(employee.id, fakeSupervisor);

    const res = await rawPost(port, '/v1/tool/bureau_task_done', token, {
      idempotencyKey: 'k1',
      args: {
        summary: 'Did the thing.',
        verified: ['it works'],
        not_verified: [],
        artifacts: [{ kind: 'code', title: 'diff', content: 'diff --git a b' }],
      },
    });
    expect((res.body as { ok: boolean }).ok, JSON.stringify(res.body)).toBe(true);

    const updated = getTaskById(db, task.id);
    expect(updated?.status).toBe('review');
    expect(updated?.result_summary).toBe('Did the thing.');
    expect(updated?.finished_at).not.toBeNull();

    const artifactRow = db.prepare('SELECT * FROM artifacts WHERE task_id = ?').get(task.id) as
      { title: string } | undefined;
    expect(artifactRow?.title).toBe('diff');

    expect(readEventTypes()).toContain('task.submitted_for_review');
    expect(notedTaskIds).toEqual([task.id]);
  });

  it('bureau_task_done rejects a task with no current task assigned', async () => {
    const { token } = makeEmployeeWithTask();
    const res = await rawPost(port, '/v1/tool/bureau_task_done', token, {
      idempotencyKey: 'k1',
      args: { summary: 's', verified: [], not_verified: [], artifacts: [] },
    });
    const body = res.body as { ok: boolean; error: { message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/no current task/);
  });

  it('bureau_task_done rejects a task already in review — first wins, no silent double-completion', async () => {
    const { task, token } = makeEmployeeWithTask({ taskAssignee: 'self' });
    db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(task.id);
    const res = await rawPost(port, '/v1/tool/bureau_task_done', token, {
      idempotencyKey: 'k1',
      args: { summary: 's', verified: [], not_verified: [], artifacts: [] },
    });
    const body = res.body as { ok: boolean; error: { message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/already 'review'/);
  });

  it('bureau_task_done CORRECTS a task left blocked/ended_without_report (the finished-race resolution)', async () => {
    const { task, token } = makeEmployeeWithTask({ taskAssignee: 'self' });
    db.prepare(
      "UPDATE tasks SET status = 'blocked', status_reason = 'ended_without_report' WHERE id = ?",
    ).run(task.id);
    const res = await rawPost(port, '/v1/tool/bureau_task_done', token, {
      idempotencyKey: 'k1',
      args: { summary: 'actually finished', verified: [], not_verified: [], artifacts: [] },
    });
    expect((res.body as { ok: boolean }).ok, JSON.stringify(res.body)).toBe(true);
    expect(getTaskById(db, task.id)?.status).toBe('review');
  });

  it('bureau_task_done: cross-employee authorization rejected AND logged as security (deliberately crossed task id)', async () => {
    const { employee: employeeA, token: tokenA } = makeEmployeeWithTask();
    const { employee: employeeB, task: taskB } = makeEmployeeWithTask({ taskAssignee: 'self' });
    // Simulate a desynced pointer: A's current_task_id points at B's task.
    setEmployeeCurrentTask(db, employeeA.id, taskB.id);

    const res = await rawPost(port, '/v1/tool/bureau_task_done', tokenA, {
      idempotencyKey: 'k1',
      args: { summary: 's', verified: [], not_verified: [], artifacts: [] },
    });
    const body = res.body as { ok: boolean; error: { message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/not the assignee/);

    // The task itself must be untouched — B's task, not A's mistaken claim.
    expect(getTaskById(db, taskB.id)?.status).not.toBe('review');
    expect(getTaskById(db, taskB.id)?.assignee_employee_id).toBe(employeeB.id);

    const securityEvent = db
      .prepare("SELECT payload FROM events WHERE type = 'control.authorization_rejected'")
      .get() as { payload: string } | undefined;
    expect(securityEvent, 'expected a control.authorization_rejected security event').toBeDefined();
    expect(JSON.parse(securityEvent?.payload ?? '{}')).toMatchObject({
      tool: 'bureau_task_done',
      reason: 'TASK_OWNERSHIP_MISMATCH',
    });
  });

  // ---- bureau_task_blocked ----

  it('bureau_task_blocked: FULL — task -> blocked with reason', async () => {
    const { task, token } = makeEmployeeWithTask({ taskAssignee: 'self' });
    const res = await rawPost(port, '/v1/tool/bureau_task_blocked', token, {
      idempotencyKey: 'k1',
      args: { reason: 'missing credentials', tried: ['checked env'], needs: 'an API key' },
    });
    expect((res.body as { ok: boolean }).ok, JSON.stringify(res.body)).toBe(true);
    const updated = getTaskById(db, task.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.status_reason).toBe('missing credentials');
    expect(readEventTypes()).toContain('task.blocked');
  });

  // ---- bureau_ask_director ----

  it('bureau_ask_director: ROW ONLY — a real messages row addressed to director', async () => {
    const { employee, token } = makeEmployeeWithTask();
    const res = await rawPost(port, '/v1/tool/bureau_ask_director', token, {
      idempotencyKey: 'k1',
      args: {
        question: 'Should I use library X?',
        context: 'It has a better API.',
        urgency: 'high',
      },
    });
    expect((res.body as { ok: boolean }).ok, JSON.stringify(res.body)).toBe(true);
    const row = db.prepare('SELECT * FROM messages WHERE from_addr = ?').get(employee.id) as
      { to_addr: string; kind: string; priority: number } | undefined;
    expect(row?.to_addr).toBe('director');
    expect(row?.kind).toBe('question');
    expect(row?.priority).toBe(80);
    expect(readEventTypes()).toContain('message.sent');
  });

  // ---- bureau_raise_checkpoint ----

  it('bureau_raise_checkpoint: ROW ONLY — a real checkpoint row, employee_id from the token', async () => {
    const { employee, token } = makeEmployeeWithTask();
    const res = await rawPost(port, '/v1/tool/bureau_raise_checkpoint', token, {
      idempotencyKey: 'k1',
      args: {
        type: 'decision',
        title: 'Pick a library',
        context: 'Two options.',
        urgency: 'soon',
        options: [
          { id: 'a', label: 'Library A', consequence: 'Faster but less documented.' },
          { id: 'b', label: 'Library B', consequence: 'Slower but well documented.' },
        ],
      },
    });
    expect((res.body as { ok: boolean }).ok, JSON.stringify(res.body)).toBe(true);
    const row = db.prepare('SELECT * FROM checkpoints WHERE employee_id = ?').get(employee.id) as
      { title: string } | undefined;
    expect(row?.title).toBe('Pick a library');
    expect(readEventTypes()).toContain('checkpoint.raised');
  });

  it('bureau_raise_checkpoint rejects an option missing consequence (§9)', async () => {
    const { token } = makeEmployeeWithTask();
    const res = await rawPost(port, '/v1/tool/bureau_raise_checkpoint', token, {
      idempotencyKey: 'k1',
      args: {
        type: 'decision',
        title: 'Pick a library',
        context: 'Two options.',
        urgency: 'soon',
        options: [{ id: 'a', label: 'Library A' }],
      },
    });
    const body = res.body as { ok: boolean; error: { message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/consequence/);
  });

  // ---- bureau_send_message ----

  it('bureau_send_message: ROW ONLY — a real messages row to the named recipient', async () => {
    const { employee, token } = makeEmployeeWithTask();
    const res = await rawPost(port, '/v1/tool/bureau_send_message', token, {
      idempotencyKey: 'k1',
      args: {
        to: 'some-other-employee-id',
        kind: 'handoff',
        subject: 'FYI',
        body: 'Here is what I found.',
      },
    });
    expect((res.body as { ok: boolean }).ok, JSON.stringify(res.body)).toBe(true);
    const row = db.prepare('SELECT * FROM messages WHERE from_addr = ?').get(employee.id) as
      { to_addr: string } | undefined;
    expect(row?.to_addr).toBe('some-other-employee-id');
    expect(readEventTypes()).toContain('message.sent');
  });

  // ---- bureau_propose_memory ----

  it('bureau_propose_memory: ROW ONLY via the activity event — no memory table row (M7 owns that)', async () => {
    const { token } = makeEmployeeWithTask();
    const res = await rawPost(port, '/v1/tool/bureau_propose_memory', token, {
      idempotencyKey: 'k1',
      args: {
        scope: 'project',
        path: 'notes/deploy.md',
        content: 'Deploy via X.',
        rationale: 'Future employees need this.',
      },
    });
    const body = res.body as { ok: boolean; data: { recorded: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.recorded).toBe(true);
    expect(readEventTypes()).toContain('memory.write_proposed');
    expect(db.prepare('SELECT COUNT(*) as n FROM memory').get()).toEqual({ n: 0 });
  });

  // ---- bureau_read_memory ----

  it('bureau_read_memory: HONEST EMPTY — well-formed empty result, no event (nothing changed)', async () => {
    const { token } = makeEmployeeWithTask();
    const beforeCount = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    const res = await rawPost(port, '/v1/tool/bureau_read_memory', token, {
      idempotencyKey: 'k1',
      args: { query: 'deploy process' },
    });
    const body = res.body as { ok: boolean; data: { results: unknown[]; reason: string } };
    expect(body.ok).toBe(true);
    expect(body.data.results).toEqual([]);
    expect(body.data.reason).toMatch(/M7/);
    const afterCount = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    expect(afterCount).toBe(beforeCount);
  });
});
