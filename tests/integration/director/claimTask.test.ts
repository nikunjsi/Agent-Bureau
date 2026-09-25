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
import { archiveEmployee, getEmployeeById } from '../../../src/main/db/repositories/employees';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { createProject } from '../../../src/main/projects/createProject';
import {
  AssignmentRefusedError,
  claimTask,
  eligibleEmployees,
} from '../../../src/main/projects/assignment';
import { reconcile } from '../../../src/main/db/reconcile';
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
 * M11 S3-2a, §8.5, §10.3's guarantee (decision E-2 of the pre-M11 plan):
 * who may take a task is decided by **one** function, `eligibleEmployees`,
 * and a task is claimed in **one** `BEGIN IMMEDIATE` transaction —
 * a task goes to at most one employee, an employee holds at most one task,
 * a second attempt gets a typed refusal, the claim survives a restart, and
 * `reconcile()` releases a claim whose employee is gone. `bureau_assign_task`
 * asks the same function and claims the same way, refusing with a reason.
 *
 * Real chain for the Director's tool: the real control channel, in a turn.
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

describe('who may take a task, and claiming it once', () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-claim-'));
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

  it('eligibility: the skills, the deliverable type, idle or off, not excluded, not the Director; ordered by the key', async () => {
    const { byTitle } = await approvedProject();
    const ada = hire('engineering:developer', 'Quinn');
    const bo = hire('engineering:developer', 'Zeb');
    const tess = hire('engineering:tester', 'Ptolemy');

    const menu = eligibleEmployees(db, byTitle('Menu page'));
    // Two developers, in hire order (equal on active tasks and role priority).
    expect(menu.eligible.map((e) => e.name)).toEqual(['Quinn', 'Zeb']);
    expect(menu.rejected.find((r) => r.employeeId === tess.id)?.reason).toMatch(/skill/);
    expect(menu.rejected.some((r) => r.reason.includes('Director'))).toBe(true);

    const testPlan = eligibleEmployees(db, byTitle('Test plan'));
    expect(testPlan.eligible.map((e) => e.name)).toEqual(['Ptolemy']);

    db.prepare('UPDATE tasks SET excluded_employees = ? WHERE id = ?').run(
      JSON.stringify([ada.id]),
      byTitle('Menu page'),
    );
    expect(eligibleEmployees(db, byTitle('Menu page')).eligible.map((e) => e.name)).toEqual([
      'Zeb',
    ]);
    expect(bo.status).toBe('off');
  });

  it('a claim is one transaction with one event, and a second claim on either side is refused', async () => {
    const { byTitle } = await approvedProject();
    const ada = hire('engineering:developer', 'Quinn');
    const bo = hire('engineering:developer', 'Zeb');
    const menu = byTitle('Menu page');
    const contact = byTitle('Contact page');

    // Two assignment paths decide at the same time, then both claim.
    const attempt = async (employeeId: string, taskId: string) => {
      await new Promise((resolve) => setImmediate(resolve));
      return claimTask({ db, activityLog }, { taskId, employeeId });
    };
    const results = await Promise.allSettled([attempt(ada.id, menu), attempt(bo.id, menu)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(AssignmentRefusedError);
    expect((lost[0]!.reason as AssignmentRefusedError).code).toBe('task_taken');

    const holder = getTaskById(db, menu)!.assignee_employee_id!;
    expect(getTaskById(db, menu)!.status).toBe('assigned');
    expect(getEmployeeById(db, holder)!.current_task_id).toBe(menu);
    expect(events('task.assigned')).toHaveLength(1);

    // The same employee cannot hold a second task.
    const again = await Promise.allSettled([attempt(holder, contact)]);
    expect(again[0]!.status).toBe('rejected');
    expect(((again[0] as PromiseRejectedResult).reason as AssignmentRefusedError).code).toBe(
      'employee_busy',
    );
    expect(getTaskById(db, contact)!.assignee_employee_id).toBeNull();
    expect(events('task.assigned')).toHaveLength(1);
  });

  it('a claim survives a restart, and reconcile releases one whose employee is gone', async () => {
    const { byTitle } = await approvedProject();
    const ada = hire('engineering:developer', 'Quinn');
    const bo = hire('engineering:developer', 'Zeb');
    claimTask({ db, activityLog }, { taskId: byTitle('Menu page'), employeeId: ada.id });
    claimTask({ db, activityLog }, { taskId: byTitle('Contact page'), employeeId: bo.id });
    archiveEmployee(db, bo.id);

    await reconcile(db, activityLog, baseDir);

    expect(getTaskById(db, byTitle('Menu page'))).toMatchObject({
      status: 'assigned',
      assignee_employee_id: ada.id,
    });
    expect(getTaskById(db, byTitle('Contact page'))).toMatchObject({
      status: 'queued',
      assignee_employee_id: null,
    });
    expect(getEmployeeById(db, bo.id)!.current_task_id).toBeNull();
    const released = events('task.reassigned');
    expect(released).toHaveLength(1);
    expect(released[0]!.payload).toMatchObject({ from: bo.id, to: null, reason: 'employee_gone' });
  });

  it('bureau_assign_task asks the same questions, refuses with a reason, and claims', async () => {
    const unapproved = await approvedProject(false);
    const ada = hire('engineering:developer', 'Quinn');
    const tess = hire('engineering:tester', 'Ptolemy');

    const early = await tool('bureau_assign_task', { task_id: unapproved.byTitle('Menu page') });
    expect(early.ok).toBe(false);
    expect(JSON.stringify(early)).toContain('not approved');

    // Approve it, and ask again, naming someone who cannot do it.
    const planId = (
      db.prepare('SELECT id FROM plans WHERE project_id = ?').get(unapproved.projectId) as {
        id: string;
      }
    ).id;
    expect((await ipc('plan', 'approve', { id: planId })).ok).toBe(true);
    await inDirectorTurn(db, supervisorRegistry, unapproved.conversationId);
    const wrong = await tool('bureau_assign_task', {
      task_id: unapproved.byTitle('Menu page'),
      employee_id: tess.id,
    });
    expect(wrong.ok).toBe(false);
    expect(JSON.stringify(wrong)).toMatch(/Ptolemy.*skill/);

    const picked = await tool('bureau_assign_task', { task_id: unapproved.byTitle('Menu page') });
    expect(picked.ok, JSON.stringify(picked)).toBe(true);
    expect(getTaskById(db, unapproved.byTitle('Menu page'))!.assignee_employee_id).toBe(ada.id);
  });
});
