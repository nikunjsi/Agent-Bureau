import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { getProjectById } from '../../../src/main/db/repositories/projects';
import { getPhaseById } from '../../../src/main/db/repositories/phases';
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { createProject } from '../../../src/main/projects/createProject';
import {
  createAssignmentLoop,
  type AssignmentLoop,
} from '../../../src/main/projects/assignmentLoop';
import { createPhaseWatcher, type PhaseWatcher } from '../../../src/main/projects/phaseReview';
import {
  createTaskCompletion,
  type TaskCompletion,
} from '../../../src/main/projects/taskCompletion';
import { getDbPaths } from '../../../src/main/db/paths';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { briefHandlers } from '../../../src/main/ipc/handlers/brief';
import { planHandlers } from '../../../src/main/ipc/handlers/plan';
import { phasesHandlers } from '../../../src/main/ipc/handlers/phases';
import { deliverablesHandlers } from '../../../src/main/ipc/handlers/deliverables';
import { deliverableFolder } from '../../../src/main/projects/deliverableActions';
import { getConversationById } from '../../../src/main/db/repositories/conversations';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { Employee } from '../../../src/shared/models/employee';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { inDirectorTurn } from '../../helpers/directorTurn';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S3-5b, §8.6, §8.5.2: **the rest of the user's decisions at a phase
 * review.** `phases.requestChanges` turns the user's words into a task in the
 * current phase: the phase is active again, the project back to executing,
 * the Director supervising (A.3 amended), the deliverables back to draft, and
 * the loop assigns the task; when it is done the phase is reviewed again.
 * `deliverables.accept` and `reject` record the user's verdict on a
 * deliverable in review (a rejection reaches the Director), and
 * `deliverables.openFolder` opens where it is.
 *
 * Real chain as in `phaseReview.test.ts`.
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

const PLAN = {
  phases: [
    { name: 'Menu', goal: 'Diners see the menu.', review_required: true },
    { name: 'Contact', goal: 'Diners can call.', review_required: true },
  ],
  tasks: [
    {
      title: 'Menu page',
      body: 'Write menu.html with every dish and its price.',
      acceptance_criteria: ['menu.html lists every dish with its price'],
      required_skills: ['code'],
      deliverable_type: 'code',
      phase_index: 0,
      estimated_cost_usd: 0.3,
    },
    {
      title: 'Contact page',
      body: 'Write contact.html with the phone number.',
      acceptance_criteria: ['contact.html shows the phone number'],
      required_skills: ['code'],
      deliverable_type: 'code',
      phase_index: 1,
      estimated_cost_usd: 0.2,
    },
  ],
  deps: [],
};

describe('changes to a phase, and the deliverables', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let triggers: DirectorTriggers;
  let ctx: HandlerContext;
  let director: FakeAdapter;
  let loop: AssignmentLoop;
  let completion: TaskCompletion;
  let phases: PhaseWatcher;
  let employeeAdapters: Map<string, FakeAdapter>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-phase-changes-'));
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
    setSetting(db, 'director.coalesceWindowSeconds', 0);
    setSetting(db, 'review.autoAcceptTrivialTasks', true);
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
    director = new FakeAdapter({
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
      createAdapter: () => director,
      resolveToolsScriptPath: resolveBureauToolsScriptPathForTests,
      directorTriggers: triggers,
    });
    expect(started.status).toBe('started');
    employeeAdapters = new Map();
    loop = createAssignmentLoop({
      db,
      activityLog,
      supervisorRegistry,
      tokenRegistry,
      controlChannelPort: server.assignedPort,
      baseDir,
      bundledPacksDir: path.resolve('packs'),
      secretBroker: noopSecretBroker,
      containProcess: () => {},
      resolveToolsScriptPath: resolveBureauToolsScriptPathForTests,
      director: triggers,
      createAdapter: (_db: Database.Database, employee: Employee) => {
        const adapter = new FakeAdapter({ keepOpen: true });
        employeeAdapters.set(employee.id, adapter);
        return adapter;
      },
    });
    completion = createTaskCompletion({ db, activityLog, director: triggers });
    phases = createPhaseWatcher({ db, activityLog, director: triggers });
  });

  afterEach(async () => {
    // Let a pass or an evaluation in flight finish before the folder goes.
    phases.stop();
    completion.stop();
    loop.stop();
    await completion.settled();
    await loop.settled();
    triggers.stop();
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const ipc = (namespace: 'brief' | 'plan', method: string, input: unknown) =>
    dispatchIpcCall(
      `${namespace}:${method}`,
      getMethodSchema(namespace, method),
      (namespace === 'brief' ? briefHandlers : planHandlers)[method]!,
      ctx,
      true,
      input,
    );

  const directorTool = (name: string, args: Record<string, unknown>) =>
    callBureauTool(director.startedContext!.controlChannel, name, args);

  const events = (type: string) =>
    readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === type);

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const endDirectorTurn = () => {
    director.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    director.pushEvent({ t: 'finished', reason: 'completed', summary: null });
  };

  /** Quinn is hired, the plan approved, and Quinn has the menu page. */
  async function quinnHasTheTask() {
    const quinn = hireEmployee({
      db,
      activityLog,
      companyId,
      baseDir,
      roleKey: 'engineering:developer',
      name: 'Quinn',
    }).employee;
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
    expect((await directorTool('bureau_write_brief', { brief: BRIEF })).ok).toBe(true);
    const briefId = (
      db.prepare('SELECT id FROM briefs WHERE project_id = ?').get(created.project.id) as {
        id: string;
      }
    ).id;
    expect((await ipc('brief', 'approve', { id: briefId })).ok).toBe(true);
    await inDirectorTurn(db, supervisorRegistry, created.conversation.id);
    expect((await directorTool('bureau_write_plan', PLAN)).ok).toBe(true);
    endDirectorTurn();
    const planId = (
      db.prepare('SELECT id FROM plans WHERE project_id = ?').get(created.project.id) as {
        id: string;
      }
    ).id;
    const turnsBefore = director.sentMessages.length;
    expect((await ipc('plan', 'approve', { id: planId })).ok).toBe(true);
    await until(() => director.sentMessages.length > turnsBefore, 'the approval turn');
    endDirectorTurn();
    await until(() => employeeAdapters.has(quinn.id), 'Quinn started');
    await loop.settled();
    const taskId = (
      db
        .prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY rowid')
        .get(created.project.id) as {
        id: string;
      }
    ).id;
    const worktree = getWorktreeById(db, getEmployeeById(db, quinn.id)!.worktree_id!)!;
    return { quinn, taskId, worktree, adapter: employeeAdapters.get(quinn.id)! };
  }

  /** Quinn's scripted turn: report done, then the turn ends. */
  async function quinnReportsDone(adapter: FakeAdapter, summary: string): Promise<void> {
    adapter.pushEvent({ t: 'turn.started', turnIndex: 0 });
    const done = await callBureauTool(adapter.startedContext!.controlChannel, 'bureau_task_done', {
      summary,
      verified: ['menu.html opens in a browser'],
      not_verified: ['prices against the printed menu'],
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    adapter.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    adapter.pushEvent({ t: 'finished', reason: 'completed', summary: null });
  }

  const ipcCall = (namespace: 'phases' | 'deliverables', method: string, input: unknown) =>
    dispatchIpcCall(
      `${namespace}:${method}`,
      getMethodSchema(namespace, method),
      (namespace === 'phases' ? phasesHandlers : deliverablesHandlers)[method]!,
      ctx,
      true,
      input,
    );

  /** Phase 1 done, reviewed by the Director, and waiting for the user. */
  async function inReview() {
    const had = await quinnHasTheTask();
    writeFileSync(path.join(had.worktree.path, 'menu.html'), '<li>Margherita — €9</li>\n');
    await quinnReportsDone(had.adapter, 'Wrote menu.html.');
    await until(() => getTaskById(db, had.taskId)!.status === 'done', 'the task accepted');
    await completion.settled();
    await until(
      () => director.sentMessages.some((m) => m.text.includes('bureau_request_review')),
      'the phase-review turn',
    );
    const phaseId = getTaskById(db, had.taskId)!.phase_id!;
    const project = getProjectById(db, getTaskById(db, had.taskId)!.project_id)!;
    director.pushEvent({ t: 'turn.started', turnIndex: 0 });
    const asked = await directorTool('bureau_request_review', {
      phase_id: phaseId,
      summary: 'The menu page is up.',
      verified: ['menu.html opens'],
      not_verified: ['prices against the printed menu'],
      known_issues: [],
    });
    expect(asked.ok, JSON.stringify(asked)).toBe(true);
    director.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    director.pushEvent({ t: 'finished', reason: 'completed', summary: null });
    const conversationId = (
      db.prepare('SELECT id FROM conversations WHERE project_id = ?').get(project.id) as {
        id: string;
      }
    ).id;
    const deliverableId = (
      db.prepare('SELECT id FROM deliverables WHERE project_id = ?').get(project.id) as {
        id: string;
      }
    ).id;
    return { ...had, phaseId, project, conversationId, deliverableId };
  }

  it('asking for changes puts a task in the phase, the work resumes, and the phase is reviewed again', async () => {
    const { quinn, phaseId, project, conversationId } = await inReview();
    const reviewTurns = () =>
      director.sentMessages.filter((m) => m.text.includes('bureau_request_review')).length;
    expect(reviewTurns()).toBe(1);

    const asked = await ipcCall('phases', 'requestChanges', {
      id: phaseId,
      feedback: 'Show the prices with the € sign.',
    });
    expect(asked.ok, JSON.stringify(asked)).toBe(true);

    expect(getPhaseById(db, phaseId)!.status).toBe('active');
    expect(getProjectById(db, project.id)!.stage).toBe('executing');
    expect(getConversationById(db, conversationId)!.director_state).toBe('SUPERVISING');
    expect(
      db.prepare('SELECT DISTINCT status FROM deliverables WHERE project_id = ?').all(project.id),
    ).toEqual([{ status: 'draft' }]);
    const change = db
      .prepare("SELECT * FROM tasks WHERE phase_id = ? AND status != 'done'")
      .get(phaseId) as { id: string; body: string };
    expect(change.body).toContain('Show the prices with the € sign.');
    expect(events('phase.changes_requested')).toHaveLength(1);

    // The loop gives it to Quinn; when it is done the phase is reviewed again.
    await until(
      () => getTaskById(db, change.id)!.assignee_employee_id === quinn.id,
      'the change assigned',
    );
    await loop.settled();
    const worktree = getWorktreeById(db, getEmployeeById(db, quinn.id)!.worktree_id!)!;
    writeFileSync(path.join(worktree.path, 'menu.html'), '<li>Margherita — € 9</li>\n');
    await quinnReportsDone(employeeAdapters.get(quinn.id)!, 'Added the € sign.');
    await until(() => getTaskById(db, change.id)!.status === 'done', 'the change accepted');
    await until(() => reviewTurns() === 2, 'the phase reviewed again');
  });

  it('a deliverable in review is accepted or rejected by the user; a rejection reaches the Director', async () => {
    const { deliverableId, conversationId } = await inReview();

    const accepted = await ipcCall('deliverables', 'accept', { id: deliverableId });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(db.prepare('SELECT status FROM deliverables WHERE id = ?').get(deliverableId)).toEqual({
      status: 'accepted',
    });
    expect(events('deliverable.accepted')).toHaveLength(1);

    // Not in review any more: it cannot be rejected now.
    const late = await ipcCall('deliverables', 'reject', {
      id: deliverableId,
      feedback: 'Too plain.',
    });
    expect(late.ok).toBe(false);

    db.prepare("UPDATE deliverables SET status = 'in_review' WHERE id = ?").run(deliverableId);
    const sent = director.sentMessages.length;
    const rejected = await ipcCall('deliverables', 'reject', {
      id: deliverableId,
      feedback: 'The menu needs photos.',
    });
    expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
    expect(db.prepare('SELECT status FROM deliverables WHERE id = ?').get(deliverableId)).toEqual({
      status: 'rejected',
    });
    expect(events('deliverable.rejected')[0]!.payload).toMatchObject({
      feedback: 'The menu needs photos.',
    });
    await until(() => director.sentMessages.length > sent, 'the Director told');
    expect(director.sentMessages.at(-1)!.text).toContain('The menu needs photos.');
    void conversationId;
  });

  it('a deliverable opens in the project folder', async () => {
    const { deliverableId, project } = await inReview();
    expect(deliverableFolder(db, deliverableId)).toBe(project.path);
  });
});
