import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
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
import { checkpointsHandlers } from '../../../src/main/ipc/handlers/checkpoints';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { Employee } from '../../../src/shared/models/employee';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { inDirectorTurn } from '../../helpers/directorTurn';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S3-4b, §8.5.1, §10.6 rules 2–3, §F P-6: **the Director decides.**
 * `bureau_accept_task` merges the task into **its phase's integration branch,
 * never `base_ref`** — the user's branch moves only at phase acceptance
 * (rule 5, S3-5) — and the task is done. `bureau_reject_task` sends it back
 * as a follow-up task in the same phase, or blocks it. When the Director
 * cannot tell, a `review` checkpoint puts the question to the user, and the
 * answer comes back to the Director. `review.autoAcceptTrivialTasks` accepts
 * a small, fully checked change without a Director turn. A task that failed
 * its checks cannot be accepted.
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

describe('the Director accepts or rejects a finished task', () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-decision-'));
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

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const projectOf = (taskId: string) =>
    getProjectById(
      db,
      (
        db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as {
          project_id: string;
        }
      ).project_id,
    )!;

  /** Quinn's menu page is done, committed and checked; the Director is asked. */
  async function reported() {
    const had = await quinnHasTheTask();
    writeFileSync(path.join(had.worktree.path, 'menu.html'), '<li>Margherita — €9</li>\n');
    await quinnReportsDone(had.adapter, 'Wrote menu.html.');
    await until(() => events('git.committed').length === 1, 'the commit');
    await completion.settled();
    await until(
      () => director.sentMessages.some((m) => m.text.includes('bureau_get_task_detail')),
      'the Director asked to evaluate',
    );
    director.pushEvent({ t: 'turn.started', turnIndex: 0 });
    return had;
  }

  it('accepting merges into the phase branch and never moves base_ref; the task is done', async () => {
    const { taskId } = await reported();
    const project = projectOf(taskId);
    const baseBefore = git(project.path, 'rev-parse', project.base_ref);
    const phaseBefore = git(project.path, 'rev-parse', 'bureau/phase/1');

    const accepted = await directorTool('bureau_accept_task', {
      task_id: taskId,
      rationale: 'Every dish is listed with its price.',
    });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);

    expect(git(project.path, 'rev-parse', project.base_ref)).toBe(baseBefore);
    const phaseAfter = git(project.path, 'rev-parse', 'bureau/phase/1');
    expect(phaseAfter).not.toBe(phaseBefore);
    expect(git(project.path, 'show', `${phaseAfter}:menu.html`)).toContain('Margherita');
    expect(getTaskById(db, taskId)!.status).toBe('done');
    expect(events('task.completed')).toHaveLength(1);
    expect(events('task.completed')[0]!.payload).toMatchObject({ mergedInto: 'bureau/phase/1' });
  });

  it('rejecting with a follow-up fails the task and queues the follow-up in the same phase', async () => {
    const { taskId } = await reported();
    const rejected = await directorTool('bureau_reject_task', {
      task_id: taskId,
      rationale: 'The prices are missing the currency.',
      follow_up: {
        title: 'Menu page: prices with the currency',
        body: 'Show every price with € in front.',
        acceptance_criteria: ['Every price shows €'],
        required_skills: ['code'],
        deliverable_type: 'code',
        estimated_cost_usd: 0.2,
      },
    });
    expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
    const original = getTaskById(db, taskId)!;
    expect(original.status).toBe('failed');
    expect(original.status_reason).toContain('currency');
    const followUp = db.prepare('SELECT * FROM tasks WHERE parent_task_id = ?').get(taskId) as {
      phase_id: string;
      title: string;
    };
    expect(followUp.phase_id).toBe(original.phase_id);
    expect(followUp.title).toBe('Menu page: prices with the currency');
    expect(events('task.failed')).toHaveLength(1);
  });

  it('rejecting with no follow-up blocks the task with the reason', async () => {
    const { taskId } = await reported();
    const rejected = await directorTool('bureau_reject_task', {
      task_id: taskId,
      rationale: 'This needs the user to say which dishes are seasonal.',
    });
    expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
    expect(getTaskById(db, taskId)).toMatchObject({
      status: 'blocked',
      status_reason: 'This needs the user to say which dishes are seasonal.',
    });
  });

  it('when the Director cannot tell, a review checkpoint asks the user, and the answer comes back to it', async () => {
    const { taskId } = await reported();
    const asked = await directorTool('bureau_raise_checkpoint', {
      type: 'review',
      urgency: 'soon',
      title: 'Is the menu page right?',
      context: 'I cannot tell whether these are this season’s prices.',
      options: [
        { id: 'accept', label: 'Accept it', consequence: 'The menu page is merged as it is.' },
        {
          id: 'reject',
          label: 'Send it back',
          consequence: 'Quinn fixes the prices first.',
          reversible: true,
        },
      ],
      default_action: 'reject',
    });
    expect(asked.ok, JSON.stringify(asked)).toBe(true);
    director.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    director.pushEvent({ t: 'finished', reason: 'completed', summary: null });
    const checkpointId = (asked as unknown as { data: { checkpointId: string } }).data.checkpointId;

    const sent = director.sentMessages.length;
    const answered = await dispatchIpcCall(
      'checkpoints:answer',
      getMethodSchema('checkpoints', 'answer'),
      checkpointsHandlers['answer']!,
      ctx,
      true,
      { id: checkpointId, optionId: 'accept' },
    );
    expect(answered.ok).toBe(true);
    await routeOnce(
      { db, activityLog, supervisorRegistry, appStartedAtMs: 0, directorTriggers: triggers },
      { nowMs: Date.now() },
    );
    await until(() => director.sentMessages.length > sent, 'the answer reaches the Director');
    expect(director.sentMessages.at(-1)!.text).toContain('Accept it');

    director.pushEvent({ t: 'turn.started', turnIndex: 0 });
    const accepted = await directorTool('bureau_accept_task', {
      task_id: taskId,
      rationale: 'The user accepted it.',
    });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(getTaskById(db, taskId)!.status).toBe('done');
  });

  it('review.autoAcceptTrivialTasks accepts a small, fully checked change with no Director turn', async () => {
    setSetting(db, 'review.autoAcceptTrivialTasks', true);
    const { taskId, worktree, adapter } = await quinnHasTheTask();
    writeFileSync(path.join(worktree.path, 'menu.html'), '<li>Margherita — €9</li>\n');
    await quinnReportsDone(adapter, 'Wrote menu.html.');
    await until(() => getTaskById(db, taskId)!.status === 'done', 'accepted automatically');
    await completion.settled();
    const project = projectOf(taskId);
    expect(git(project.path, 'show', 'bureau/phase/1:menu.html')).toContain('Margherita');
    expect(events('task.completed')[0]!.payload).toMatchObject({ by: 'auto' });
    // The Director is told, not asked.
    await until(
      () => director.sentMessages.some((m) => m.text.includes('accepted automatically')),
      'the Director told',
    );
    expect(director.sentMessages.some((m) => m.text.includes('bureau_get_task_detail'))).toBe(
      false,
    );
  });

  it('a change over the trivial limit is not accepted automatically; the Director is asked', async () => {
    setSetting(db, 'review.autoAcceptTrivialTasks', true);
    setSetting(db, 'review.trivialTaskMaxChangedLines', 0);
    const { taskId, worktree, adapter } = await quinnHasTheTask();
    writeFileSync(path.join(worktree.path, 'menu.html'), '<li>Margherita — €9</li>\n');
    await quinnReportsDone(adapter, 'Wrote menu.html.');
    await until(
      () => director.sentMessages.some((m) => m.text.includes('bureau_get_task_detail')),
      'the Director asked',
    );
    expect(getTaskById(db, taskId)!.status).toBe('review');
    expect(events('task.completed')).toHaveLength(0);
  });

  it('a task that failed its checks cannot be accepted', async () => {
    const { taskId, worktree, adapter } = await quinnHasTheTask();
    const failingTests = JSON.stringify({
      name: 'site',
      scripts: { test: 'node -e "process.exit(1)"' },
    });
    writeFileSync(path.join(projectOf(taskId).path, 'package.json'), failingTests);
    writeFileSync(path.join(worktree.path, 'package.json'), failingTests);
    await quinnReportsDone(adapter, 'Done, all tests pass.');
    await until(() => events('git.validator_failed').length === 1, 'the failed check');
    await completion.settled();

    const conversation = db
      .prepare(
        'SELECT id FROM conversations WHERE project_id = (SELECT project_id FROM tasks WHERE id = ?)',
      )
      .get(taskId) as { id: string };
    await inDirectorTurn(db, supervisorRegistry, conversation.id);
    const refused = await directorTool('bureau_accept_task', {
      task_id: taskId,
      rationale: 'Looks fine.',
    });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('not in review');
    expect(getTaskById(db, taskId)!.status).toBe('blocked');
  });
});
