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
 * M11 S3-4a, §8.5.1, risk #10: **how a task actually completes.** When an
 * employee reports done (`bureau_task_done`) and its turn ends, the Core
 * commits its work and runs the validators (`commitTaskWork`). A validator
 * failure blocks the task and gives the employee **one** repair attempt, with
 * the output; a second failure leaves it blocked and tells the Director. A
 * pass hands the Director a coalesced trigger with the summary, what was and
 * was not verified, the changed files and the validator output, and
 * `bureau_get_task_detail` gives it the diff.
 *
 * Risk #10: an employee that reports done while its own tests fail is not
 * accepted — its work is never committed and the task never completes.
 *
 * Real chain: the Director's tools, the loop, the router, real git and real
 * validators; employees on FakeAdapter, their tool calls over the real
 * control channel.
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

describe('how a task completes', () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-completion-'));
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
    completion.stop();
    loop.stop();
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

  it('a pass: the work is committed, and the Director gets the summary, the checks and the diff', async () => {
    const { taskId, worktree, adapter } = await quinnHasTheTask();
    writeFileSync(path.join(worktree.path, 'menu.html'), '<li>Margherita — €9</li>\n');

    await quinnReportsDone(adapter, 'Wrote menu.html with the dishes and prices.');
    await until(() => events('git.committed').length === 1, 'the commit');
    await completion.settled();

    expect(getTaskById(db, taskId)!.status).toBe('review');
    await until(
      () => director.sentMessages.some((m) => m.text.includes('bureau_get_task_detail')),
      'the Director asked to evaluate',
    );
    const turn = director.sentMessages.find((m) => m.text.includes('bureau_get_task_detail'))!;
    expect(turn.text).toContain('Wrote menu.html with the dishes and prices.');
    expect(turn.text).toContain('prices against the printed menu');
    expect(turn.text).toContain('menu.html');
    expect(turn.text).toContain('secret-scan: passed');

    // The Director looks closer.
    director.pushEvent({ t: 'turn.started', turnIndex: 0 });
    const detail = await directorTool('bureau_get_task_detail', { task_id: taskId });
    expect(detail.ok, JSON.stringify(detail)).toBe(true);
    const data = (detail as unknown as { data: Record<string, unknown> }).data;
    expect(data['acceptanceCriteria']).toEqual(['menu.html lists every dish with its price']);
    expect(data['notVerified']).toEqual(['prices against the printed menu']);
    expect(String(data['diff'])).toContain('Margherita');
    expect(data['changedFiles']).toEqual(['menu.html']);
  });

  it('risk #10: done while its own tests fail is not accepted — one repair attempt, then the Director', async () => {
    const { quinn, taskId, worktree, adapter } = await quinnHasTheTask();
    // The project defines its tests (checks are detected from the project's
    // own folder — M11 plan §F S3-4a), and they fail on Quinn's work.
    const failingTests = JSON.stringify({
      name: 'site',
      scripts: { test: 'node -e "process.exit(1)"' },
    });
    const projectPath = (
      db
        .prepare('SELECT path FROM projects WHERE id = (SELECT project_id FROM tasks WHERE id = ?)')
        .get(taskId) as { path: string }
    ).path;
    writeFileSync(path.join(projectPath, 'package.json'), failingTests);
    writeFileSync(path.join(worktree.path, 'package.json'), failingTests);
    writeFileSync(path.join(worktree.path, 'menu.html'), '<li>Margherita — €9</li>\n');

    await quinnReportsDone(adapter, 'Done, all tests pass.');
    await until(() => events('git.validator_failed').length === 1, 'the failed check');
    await completion.settled();

    let task = getTaskById(db, taskId)!;
    expect(task.status).toBe('blocked');
    expect(task.attempts).toBe(1);
    expect(events('git.committed')).toHaveLength(0);

    // The one repair attempt: the failure goes back to Quinn.
    const sentBefore = adapter.sentMessages.length;
    await routeOnce(
      { db, activityLog, supervisorRegistry, appStartedAtMs: 0, directorTriggers: triggers },
      { nowMs: Date.now() },
    );
    await until(() => adapter.sentMessages.length > sentBefore, 'the repair message');
    expect(adapter.sentMessages.at(-1)!.text).toMatch(/checks failed/i);
    expect(adapter.sentMessages.at(-1)!.text).toContain('test');

    // Quinn says done again; it still fails.
    await quinnReportsDone(adapter, 'Fixed, tests pass now.');
    await until(() => events('git.validator_failed').length === 2, 'the second failed check');
    await completion.settled();

    task = getTaskById(db, taskId)!;
    expect(task.status).toBe('blocked');
    expect(task.attempts).toBe(2);
    expect(events('git.committed')).toHaveLength(0);
    await until(
      () => director.sentMessages.some((m) => m.text.includes('failed its checks twice')),
      'the Director told',
    );
    expect(getEmployeeById(db, quinn.id)!.current_task_id).toBe(taskId);
  });
});
