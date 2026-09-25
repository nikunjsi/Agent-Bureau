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
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { routeOnce } from '../../../src/main/messages/router';
import { createProject } from '../../../src/main/projects/createProject';
import {
  createAssignmentLoop,
  type AssignmentLoop,
} from '../../../src/main/projects/assignmentLoop';
import { projectDigest } from '../../../src/main/projects/progressDigest';
import { createStallWatcher } from '../../../src/main/projects/stallWatcher';
import { getCheckpointById } from '../../../src/main/db/repositories/checkpoints';
import {
  createTaskCompletion,
  type TaskCompletion,
} from '../../../src/main/projects/taskCompletion';
import { getDbPaths } from '../../../src/main/db/paths';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { briefHandlers } from '../../../src/main/ipc/handlers/brief';
import { planHandlers } from '../../../src/main/ipc/handlers/plan';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { Employee } from '../../../src/shared/models/employee';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { inDirectorTurn } from '../../helpers/directorTurn';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S3-6b, §8.5, §8.8: **reports, stalls and repeated failure.** The
 * progress digest reads the real rows (done, blocked and waiting work with
 * its reasons, spend against budget) and is what a heartbeat and a phase
 * boundary report from. A task silent past `orchestrator.stallTimeoutS`
 * reaches the Director once. A task that fails its checks after its repair
 * attempt is reassigned with that employee excluded, until
 * `orchestrator.maxReassignments`; then a blocker says what was tried.
 *
 * Real chain as in `taskCompletion.test.ts`.
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
  phases: [{ name: 'Site', goal: 'A site.', review_required: true }],
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
  ],
  deps: [],
};

describe('reports, stalls and repeated failure', () => {
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
  let employeeAdapters: Map<string, FakeAdapter>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-progress-'));
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
  });

  afterEach(async () => {
    // Let a pass or an evaluation in flight finish before the folder goes.
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
      db.prepare('SELECT id FROM tasks WHERE project_id = ?').get(created.project.id) as {
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

  const failingTests = JSON.stringify({
    name: 'site',
    scripts: { test: 'node -e "process.exit(1)"' },
  });

  const projectPathOf = (taskId: string) =>
    (
      db
        .prepare('SELECT path FROM projects WHERE id = (SELECT project_id FROM tasks WHERE id = ?)')
        .get(taskId) as { path: string }
    ).path;

  /** An employee reports done while the project's tests fail, twice: its
   *  one repair attempt fails too. */
  async function failsTwice(adapter: FakeAdapter, worktreePath: string): Promise<void> {
    writeFileSync(path.join(worktreePath, 'package.json'), failingTests);
    writeFileSync(path.join(worktreePath, 'menu.html'), '<li>Margherita</li>\n');
    const before = events('git.validator_failed').length;
    await quinnReportsDone(adapter, 'Done, tests pass.');
    await until(() => events('git.validator_failed').length === before + 1, 'the first failure');
    await completion.settled();
    await routeOnce(
      { db, activityLog, supervisorRegistry, appStartedAtMs: 0, directorTriggers: triggers },
      { nowMs: Date.now() },
    );
    await quinnReportsDone(adapter, 'Fixed, tests pass.');
    await until(() => events('git.validator_failed').length === before + 2, 'the second failure');
    await completion.settled();
  }

  it('the progress digest reads the real state of the work', async () => {
    const { taskId } = await quinnHasTheTask();
    const projectId = getTaskById(db, taskId)!.project_id;
    db.prepare(
      "UPDATE tasks SET status = 'blocked', status_reason = 'Needs the menu PDF.' WHERE id = ?",
    ).run(taskId);
    const digest = projectDigest(db, projectId);
    expect(digest).toContain('Luigi Trattoria');
    expect(digest).toContain('0 of 1 task done');
    expect(digest).toContain('Needs the menu PDF.');
    expect(digest).toMatch(/spent \$0\.00 of \$/);
  });

  it('a task silent past the stall timeout reaches the Director, once', async () => {
    setSetting(db, 'orchestrator.stallTimeoutS', 60);
    const { taskId } = await quinnHasTheTask();
    const watcher = createStallWatcher({ db, activityLog, director: triggers, intervalMs: 0 });
    const sent = director.sentMessages.length;
    watcher.check(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(director.sentMessages.length).toBe(sent);

    watcher.check(Date.now() + 61_000);
    await until(() => director.sentMessages.length > sent, 'the stall reported');
    const turn = director.sentMessages.at(-1)!.text;
    expect(turn).toContain(getTaskById(db, taskId)!.display_key);
    expect(turn).toMatch(/nothing.*for/i);

    endDirectorTurn();
    const after = director.sentMessages.length;
    watcher.check(Date.now() + 62_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(director.sentMessages.length).toBe(after);
    watcher.stop();
  });

  it('a task that keeps failing is reassigned without its last employee, then blocked with what was tried', async () => {
    setSetting(db, 'orchestrator.maxReassignments', 1);
    const { quinn, taskId, worktree, adapter } = await quinnHasTheTask();
    const zeb = hireEmployee({
      db,
      activityLog,
      companyId,
      baseDir,
      roleKey: 'engineering:developer',
      name: 'Zeb',
    }).employee;
    writeFileSync(path.join(projectPathOf(taskId), 'package.json'), failingTests);

    await failsTwice(adapter, worktree.path);
    let task = getTaskById(db, taskId)!;
    expect(task.excluded_employees).toContain(quinn.id);
    expect(task.reassignments).toBe(1);
    expect(events('task.reassigned').at(-1)!.payload).toMatchObject({
      from: quinn.id,
      reason: 'failed_checks',
    });

    // The loop gives it to Zeb, who fails the same way.
    await until(() => getTaskById(db, taskId)!.assignee_employee_id === zeb.id, 'Zeb has it');
    await loop.settled();
    const zebWorktree = getWorktreeById(db, getEmployeeById(db, zeb.id)!.worktree_id!)!;
    await failsTwice(employeeAdapters.get(zeb.id)!, zebWorktree.path);

    task = getTaskById(db, taskId)!;
    expect(task.status).toBe('blocked');
    const blocker = db
      .prepare(
        "SELECT id FROM checkpoints WHERE type = 'blocker' AND task_id = ? AND status = 'pending'",
      )
      .get(taskId) as { id: string };
    const checkpoint = getCheckpointById(db, blocker.id)!;
    expect(checkpoint.title).toMatch(/failed/);
    expect(checkpoint.context).toContain('Quinn');
    expect(checkpoint.context).toContain('Zeb');
  });
});
