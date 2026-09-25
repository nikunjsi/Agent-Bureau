import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
import { getProjectById, setProjectBriefAndPlan } from '../../../src/main/db/repositories/projects';
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
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { Employee } from '../../../src/shared/models/employee';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';
import { SummaryCard } from '../../../src/renderer/src/components/chat/kinds';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { inDirectorTurn } from '../../helpers/directorTurn';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';
import { seedPhase, seedPlan, seedTask } from '../../helpers/dbFixtures';

/**
 * M11 S3-11, §19's "Director behaviour" row, risks #7 and #8: **what the
 * Director may and may not do, as scripted conversations.** The Director
 * runs on FakeAdapter, its tool calls go through the real control channel
 * (the bridge), and the user's side goes through the real IPC handlers. Each
 * property is shown as the mechanism the code enforces, so a Director that
 * tried the wrong thing is refused, whatever it was thinking:
 *
 * - it never builds before the brief is approved;
 * - it batches its questions;
 * - it never asks again what is already answered;
 * - ambiguity goes to it as conversation, and an approach that has failed
 *   twice becomes the user's decision;
 * - it says what was not verified, when it accepts work and when it puts a
 *   phase to the user, and the card shows it.
 *
 * **The model's judgement is not tested here.** Whether a real Director
 * asks good questions, writes a sound plan or evaluates work well is what
 * the gate run tests (M11 §GATE), on a real engine. This file proves only
 * that the rails hold.
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

describe('the Director’s behaviour, held by the code', () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-behaviour-'));
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
    await completion.settled();
    await loop.settled();
    triggers.stop();
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const ipc = (namespace: 'brief' | 'plan' | 'chat', method: string, input: unknown) =>
    dispatchIpcCall(
      `${namespace}:${method}`,
      getMethodSchema(namespace, method),
      (namespace === 'brief' ? briefHandlers : namespace === 'plan' ? planHandlers : chatHandlers)[
        method
      ]!,
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

  const hireQuinn = () =>
    hireEmployee({
      db,
      activityLog,
      companyId,
      baseDir,
      roleKey: 'engineering:developer',
      name: 'Quinn',
    }).employee;

  /** The user describes new work; a project is in intake, and the Director
   *  is in a turn in its conversation. */
  async function projectInIntake() {
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
    return created;
  }

  /** Brief approved, plan approved, and Quinn has the menu page. */
  async function quinnHasTheTask() {
    const quinn = hireQuinn();
    const created = await projectInIntake();
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

  const q = (id: string, text: string) => ({
    id,
    text,
    options: [
      { id: 'a', label: 'Yes' },
      { id: 'b', label: 'No' },
    ],
    recommendation: { optionId: 'a', why: 'It is the simpler start.' },
  });

  const ask = (questions: unknown[]) =>
    directorTool('bureau_report', {
      kind: 'question',
      body: 'A few questions before I write the brief.',
      payload: { questions },
    });

  it('never builds before the brief is approved: no plan, no assignment, nobody started', async () => {
    const quinn = hireQuinn();
    const { project } = await projectInIntake();
    expect((await directorTool('bureau_write_brief', { brief: BRIEF })).ok).toBe(true);

    // The brief is written, not approved: the plan is refused, and nothing is written.
    const plan = await directorTool('bureau_write_plan', PLAN);
    expect(plan.ok).toBe(false);
    // Refused by the rule, in words the Director can act on — not by a row
    // that happens to be missing further down.
    expect(JSON.stringify(plan)).toContain('before the brief is approved');
    expect(db.prepare('SELECT COUNT(*) AS n FROM plans').get()).toEqual({ n: 0 });

    // Work that exists anyway (a plan not yet approved) cannot be handed out.
    const draft = seedPlan(db, { project_id: project.id, status: 'awaiting_approval' });
    const phase = seedPhase(db, { plan_id: draft.id });
    const task = seedTask(db, { project_id: project.id, phase_id: phase.id });
    setProjectBriefAndPlan(db, project.id, getProjectById(db, project.id)!.brief_id, draft.id);
    const assigned = await directorTool('bureau_assign_task', {
      task_id: task.id,
      employee_id: quinn.id,
    });
    expect(assigned.ok).toBe(false);
    loop.kick();
    await loop.settled();
    expect(employeeAdapters.size).toBe(0);
    expect(getTaskById(db, task.id)!.assignee_employee_id).toBeNull();
    expect(getEmployeeById(db, quinn.id)!.status).toBe('off');
  });

  it('batches its questions: a round of one is refused, a round of two is posted', async () => {
    await projectInIntake();
    const one = await ask([q('menu', 'Should the menu be on the site?')]);
    expect(one.ok).toBe(false);
    expect(JSON.stringify(one)).toContain('never one at a time');

    const two = await ask([
      q('menu', 'Should the menu be on the site?'),
      q('photos', 'Do you have photos of the dishes?'),
    ]);
    expect(two.ok, JSON.stringify(two)).toBe(true);
  });

  it('never asks again what the decision log already answers', async () => {
    await projectInIntake();
    const recorded = await directorTool('bureau_record_decision', {
      title: 'Should diners book a table online or by phone?',
      asked_because: 'The owner takes bookings by phone today.',
      options: ['Online', 'By phone'],
      chosen: 'By phone — the owner wants to keep talking to regulars.',
      consequence: 'No booking system to build.',
    });
    expect(recorded.ok, JSON.stringify(recorded)).toBe(true);

    const again = await ask([
      q('booking', 'Should diners book a table online or by phone?'),
      q('menu', 'Should the menu be on the site?'),
    ]);
    expect(again.ok).toBe(false);
    expect(JSON.stringify(again)).toContain('By phone');
  });

  it('ambiguity reaches it as conversation, and creates nothing', async () => {
    const company = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Test Co',
    });
    const sent = await ipc('chat', 'send', { conversationId: company.id, body: 'make it nicer' });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    await routeOnce(
      { db, activityLog, supervisorRegistry, appStartedAtMs: 0, directorTriggers: triggers },
      { nowMs: Date.now() },
    );
    await until(
      () => director.sentMessages.some((m) => m.text.includes('make it nicer')),
      'the Director hears it',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
    expect(events('director.intake_started')).toEqual([]);
  });

  it('an approach that has failed twice becomes a blocker for the user', async () => {
    setSetting(db, 'orchestrator.maxReassignments', 0);
    const { taskId, worktree, adapter } = await quinnHasTheTask();
    const failing = JSON.stringify({
      name: 'site',
      scripts: { test: 'node -e "process.exit(1)"' },
    });
    // Validators are detected from the project's root (M11 plan §F), and run in the worktree.
    const projectPath = getProjectById(db, getTaskById(db, taskId)!.project_id)!.path;
    writeFileSync(path.join(projectPath, 'package.json'), failing);
    writeFileSync(path.join(worktree.path, 'package.json'), failing);
    writeFileSync(path.join(worktree.path, 'menu.html'), '<li>Margherita</li>\n');

    await quinnReportsDone(adapter, 'Done, tests pass.');
    await until(() => events('git.validator_failed').length === 1, 'the first failure');
    await completion.settled();
    await routeOnce(
      { db, activityLog, supervisorRegistry, appStartedAtMs: 0, directorTriggers: triggers },
      { nowMs: Date.now() },
    );
    await quinnReportsDone(adapter, 'Fixed, tests pass.');
    await until(() => events('git.validator_failed').length === 2, 'the second failure');
    await completion.settled();

    expect(getTaskById(db, taskId)!.status).toBe('blocked');
    const blocker = db
      .prepare(
        "SELECT title FROM checkpoints WHERE type = 'blocker' AND task_id = ? AND status = 'pending'",
      )
      .get(taskId) as { title: string } | undefined;
    expect(blocker?.title).toMatch(/failed/);
  });

  it('says what was not verified when it accepts work and when it puts a phase to the user, and the card shows it', async () => {
    const { taskId, worktree, adapter } = await quinnHasTheTask();
    writeFileSync(path.join(worktree.path, 'menu.html'), '<li>Margherita — €9</li>\n');
    await quinnReportsDone(adapter, 'Wrote menu.html.');
    await until(() => events('git.committed').length === 1, 'the commit');
    await completion.settled();
    await until(
      () => director.sentMessages.some((m) => m.text.includes('bureau_get_task_detail')),
      'the Director asked to evaluate',
    );
    director.pushEvent({ t: 'turn.started', turnIndex: 0 });

    const silent = await directorTool('bureau_accept_task', {
      task_id: taskId,
      rationale: 'Every dish is listed with its price.',
      not_verified: [],
    });
    expect(silent.ok).toBe(false);
    expect(JSON.stringify(silent)).toContain('not_verified');
    expect(getTaskById(db, taskId)!.status).toBe('review');

    const accepted = await directorTool('bureau_accept_task', {
      task_id: taskId,
      rationale: 'Every dish is listed with its price.',
      not_verified: ['prices against the printed menu'],
    });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(events('task.completed').at(-1)!.payload).toMatchObject({
      notVerified: ['prices against the printed menu'],
    });

    const phaseId = getTaskById(db, taskId)!.phase_id!;
    const review = (notVerified: string[]) =>
      directorTool('bureau_request_review', {
        phase_id: phaseId,
        summary: 'The menu page is up: every dish with its price.',
        verified: ['menu.html opens and lists the dishes'],
        not_verified: notVerified,
        known_issues: [],
      });
    expect((await review([])).ok).toBe(false);
    expect((await review(['prices against the printed menu'])).ok).toBe(true);

    const card = db
      .prepare("SELECT * FROM conversation_messages WHERE kind = 'summary' ORDER BY rowid DESC")
      .get() as Record<string, unknown>;
    const html = renderToStaticMarkup(
      createElement(SummaryCard, {
        message: { ...card, payload: JSON.parse(card['payload'] as string) } as ConversationMessage,
      }),
    );
    expect(html).toContain('Not verified');
    expect(html).toContain('prices against the printed menu');
  });
});
