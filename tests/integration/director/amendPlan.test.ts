import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { createProject } from '../../../src/main/projects/createProject';
import { claimTask, eligibleEmployees } from '../../../src/main/projects/assignment';
import { getCheckpointById } from '../../../src/main/db/repositories/checkpoints';
import { checkpointsHandlers } from '../../../src/main/ipc/handlers/checkpoints';
import { spawnSupervisedEmployee } from '../../../src/main/engine/spawnSupervisedEmployee';
import { getDbPaths } from '../../../src/main/db/paths';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { briefHandlers } from '../../../src/main/ipc/handlers/brief';
import { planHandlers } from '../../../src/main/ipc/handlers/plan';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { inDirectorTurn } from '../../helpers/directorTurn';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S3-6a, §8.5, §8.8, §7.9: **re-planning, and stopping an employee.**
 * `bureau_amend_plan` applies a change that alters neither cost nor scope (a
 * clearer body for a queued task) silently, with its one event; anything that
 * adds or removes work, changes acceptance criteria or changes the estimate
 * becomes a `decision` checkpoint showing the change and its cost, and only
 * the user's "apply" applies it. Running or finished work is never amended.
 * `bureau_stop_employee` parks an employee and blocks its task with the
 * reason; the Director cannot stop itself.
 *
 * Real chain: the Director's tools over the real control channel, the real
 * checkpoint answer.
 */
const BRIEF = {
  title: 'Luigi Trattoria website',
  one_liner: 'A small site.',
  goal: 'Diners find the phone number.',
  kind: 'software',
  users: 'Diners.',
  scope: ['A menu page'],
  non_goals: [],
  deliverables: [
    { type: 'repository', name: 'Website', description: 'The site.', acceptance: ['Loads'] },
  ],
  constraints: { tech: [], platform: ['Web'], deadline: null, budget_usd: null, other: [] },
  existing_assets: [],
  success_criteria: ['It loads'],
  assumptions: [],
  open_questions: [],
  risks: [],
};

const task = (title: string, overrides: Record<string, unknown> = {}) => ({
  title,
  body: `Do: ${title}.`,
  acceptance_criteria: [`${title} works`],
  required_skills: ['code'],
  deliverable_type: 'code',
  phase_index: 0,
  estimated_cost_usd: 0.1,
  ...overrides,
});

const PLAN = {
  phases: [{ name: 'Site', goal: 'A site.', review_required: true }],
  tasks: [
    task('Menu page'),
    task('Contact page'),
    task('Test plan', { required_skills: ['testing'] }),
  ],
  deps: [],
};

describe('re-planning, and stopping an employee', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let triggers: DirectorTriggers;
  let ctx: HandlerContext;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-amend-'));
    baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: path.resolve('src/main/db/migrations'),
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    companyId = seedCompany(db, path.join(tmpDir, 'home')).id;
    installShippedPack({ db, activityLog, baseDir, packKey: 'operations' });
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });
    supervisorRegistry = new SupervisorRegistry();
    const tokenRegistry = new TokenRegistry();
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      baseDir,
    });
    await server.start();
    triggers = createDirectorTriggers({
      db,
      activityLog,
      supervisorRegistry,
      baseDir,
      bundledPacksDir: path.resolve('packs'),
    });
    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, path.resolve('src/main/db/migrations')),
      baseDir,
      directorTriggers: triggers,
    } as unknown as HandlerContext;
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' });
    adapter = new FakeAdapter({
      keepOpen: true,
      capabilities: { mcpServers: true, sessionResume: true },
    });
    const started = await startDirector({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      controlChannelPort: server.assignedPort,
      baseDir,
      secretBroker: noopSecretBroker,
      containProcess: () => {},
      createAdapter: () => adapter,
      resolveToolsScriptPath: resolveBureauToolsScriptPathForTests,
      directorTriggers: triggers,
    });
    expect(started.status).toBe('started');
  });

  afterEach(async () => {
    triggers.stop();
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const tool = (name: string, args: Record<string, unknown>) =>
    callBureauTool(adapter.startedContext!.controlChannel, name, args);

  const ipc = (namespace: 'brief' | 'plan', method: string, input: unknown) =>
    dispatchIpcCall(
      `${namespace}:${method}`,
      getMethodSchema(namespace, method),
      (namespace === 'brief' ? briefHandlers : planHandlers)[method]!,
      ctx,
      true,
      input,
    );

  const events = (type: string) =>
    readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === type);

  const hire = (roleKey: string, name: string) =>
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey, name }).employee;

  /** A project with an approved brief and plan, and the Director in its turn. */
  async function approvedProject(approvePlan = true) {
    const company = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Test Co',
    });
    const created = createProject(
      { db, activityLog },
      {
        companyId,
        name: 'Luigi Trattoria',
        conversation: { bind: company.id },
        actor: 'user',
        reason: 'test',
      },
    );
    await inDirectorTurn(db, supervisorRegistry, created.conversation.id);
    expect((await tool('bureau_write_brief', { brief: BRIEF })).ok).toBe(true);
    const briefId = (
      db.prepare('SELECT id FROM briefs WHERE project_id = ?').get(created.project.id) as {
        id: string;
      }
    ).id;
    expect((await ipc('brief', 'approve', { id: briefId })).ok).toBe(true);
    await inDirectorTurn(db, supervisorRegistry, created.conversation.id);
    expect((await tool('bureau_write_plan', PLAN)).ok).toBe(true);
    const planId = (
      db.prepare('SELECT id FROM plans WHERE project_id = ?').get(created.project.id) as {
        id: string;
      }
    ).id;
    if (approvePlan) expect((await ipc('plan', 'approve', { id: planId })).ok).toBe(true);
    await inDirectorTurn(db, supervisorRegistry, created.conversation.id);
    const byTitle = (title: string) =>
      (
        db
          .prepare('SELECT id FROM tasks WHERE project_id = ? AND title = ?')
          .get(created.project.id, title) as { id: string }
      ).id;
    return { projectId: created.project.id, conversationId: created.conversation.id, byTitle };
  }

  const answer = (id: string, optionId: string) =>
    dispatchIpcCall(
      'checkpoints:answer',
      getMethodSchema('checkpoints', 'answer'),
      checkpointsHandlers['answer']!,
      ctx,
      true,
      { id, optionId },
    );

  it('a clearer body for a queued task is applied silently, with one event', async () => {
    const { byTitle } = await approvedProject();
    const amended = await tool('bureau_amend_plan', {
      rescope: [
        { task_id: byTitle('Menu page'), body: 'Do: Menu page, dishes grouped by course.' },
      ],
      rationale: 'Grouping by course was implied by the brief.',
    });
    expect(amended.ok, JSON.stringify(amended)).toBe(true);
    expect(JSON.stringify(amended)).toContain('"applied":true');
    expect(getTaskById(db, byTitle('Menu page'))!.body).toBe(
      'Do: Menu page, dishes grouped by course.',
    );
    expect(events('project.plan_amended')).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE type = 'decision'").get(),
    ).toEqual({
      n: 0,
    });
  });

  it('adding work is a decision with its cost; only "apply" changes the plan', async () => {
    const { projectId, byTitle } = await approvedProject();
    const proposed = await tool('bureau_amend_plan', {
      add: [
        {
          title: 'Opening hours',
          body: 'Show the opening hours on the contact page.',
          acceptance_criteria: ['The hours are on the contact page'],
          required_skills: ['code'],
          deliverable_type: 'code',
          phase_index: 0,
          estimated_cost_usd: 0.25,
        },
      ],
      remove: [byTitle('Contact page')],
      rationale: 'The contact page is being folded into the hours task.',
    });
    expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
    const checkpointId = (proposed as unknown as { data: { checkpointId: string } }).data
      .checkpointId;
    const checkpoint = getCheckpointById(db, checkpointId)!;
    expect(checkpoint.type).toBe('decision');
    expect(checkpoint.default_action).toBe('keep');
    // The cost change: +$0.25 for the new task, −$0.10 for the removed one.
    expect(checkpoint.options!.find((o) => o.id === 'apply')!.consequence).toContain('$0.15');
    // Nothing changed yet.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Opening hours'").get(),
    ).toEqual({ n: 0 });
    expect(getTaskById(db, byTitle('Contact page'))!.status).toBe('queued');

    expect((await answer(checkpointId, 'apply')).ok).toBe(true);
    const added = db
      .prepare("SELECT * FROM tasks WHERE title = 'Opening hours' AND project_id = ?")
      .get(projectId) as { status: string; phase_id: string };
    expect(added.status).toBe('queued');
    expect(added.phase_id).toBe(getTaskById(db, byTitle('Menu page'))!.phase_id);
    expect(getTaskById(db, byTitle('Contact page'))!.status).toBe('cancelled');
    expect(events('project.plan_amended')).toHaveLength(1);
  });

  it('declining keeps the plan as it was', async () => {
    const { byTitle } = await approvedProject();
    const proposed = await tool('bureau_amend_plan', {
      remove: [byTitle('Contact page')],
      rationale: 'Not needed.',
    });
    const checkpointId = (proposed as unknown as { data: { checkpointId: string } }).data
      .checkpointId;
    expect((await answer(checkpointId, 'keep')).ok).toBe(true);
    expect(getTaskById(db, byTitle('Contact page'))!.status).toBe('queued');
    expect(events('project.plan_amended')).toHaveLength(0);
  });

  it('work someone holds is never amended', async () => {
    const { byTitle } = await approvedProject();
    const quinn = hire('engineering:developer', 'Quinn');
    claimTask({ db, activityLog }, { taskId: byTitle('Menu page'), employeeId: quinn.id });
    const refused = await tool('bureau_amend_plan', {
      rescope: [{ task_id: byTitle('Menu page'), body: 'Something else.' }],
      rationale: 'Changed my mind.',
    });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('assigned');
  });

  it('stopping an employee parks them and blocks their task with the reason; the Director cannot stop itself', async () => {
    const { byTitle } = await approvedProject();
    const quinn = hire('engineering:developer', 'Quinn');
    claimTask({ db, activityLog }, { taskId: byTitle('Menu page'), employeeId: quinn.id });
    const spawned = await spawnSupervisedEmployee({
      db,
      activityLog,
      tokenRegistry: new TokenRegistry(),
      supervisorRegistry,
      controlChannelPort: server.assignedPort,
      employeeId: quinn.id,
      adapter: new FakeAdapter({ keepOpen: true }),
      baseDir,
    });
    void spawned;

    const stopped = await tool('bureau_stop_employee', {
      employee_id: quinn.id,
      reason: 'It keeps rewriting the same file.',
    });
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
    expect(getEmployeeById(db, quinn.id)!.status).toBe('parked');
    expect(getTaskById(db, byTitle('Menu page'))).toMatchObject({
      status: 'blocked',
      status_reason: 'Stopped by the Director: It keeps rewriting the same file.',
    });
    expect(eligibleEmployees(db, byTitle('Contact page')).eligible.map((e) => e.id)).not.toContain(
      quinn.id,
    );

    const directorId = (
      db.prepare('SELECT id FROM employees WHERE is_director = 1').get() as { id: string }
    ).id;
    const self = await tool('bureau_stop_employee', { employee_id: directorId, reason: 'x' });
    expect(self.ok).toBe(false);
  });
});
