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
import { getPhaseById } from '../../../src/main/db/repositories/phases';
import { getCheckpointById } from '../../../src/main/db/repositories/checkpoints';
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
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { Employee } from '../../../src/shared/models/employee';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { inDirectorTurn } from '../../helpers/directorTurn';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S3-5a, §8.6, §10.6 rule 5, `NEXT-VERSION` §D.2: **phase review, and
 * merging into `base_ref` only when the user accepts the phase.** When a
 * phase's last task is done, the Director gets a phase-review turn (not
 * coalesced). `bureau_request_review` moves the phase and the project to
 * review, the deliverables to `in_review`, and posts the review card with
 * what was verified and what was **not** (an empty "not verified" is
 * refused). `phases.accept` makes the Core merge `bureau/phase/<n>` into
 * `base_ref` — the only write to it — and **never moves the branch under the
 * user's own checkout**: a checked-out `base_ref` is updated only when the
 * checkout is clean and the merge is a fast-forward; otherwise a blocker
 * checkpoint says why and nothing moves. Then the next phase starts.
 *
 * Real chain as in `taskCompletion.test.ts`; tasks are accepted automatically
 * here (`review.autoAcceptTrivialTasks`), since this is about the phase.
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

describe('phase review, and rule 5', () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-phase-review-'));
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

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const acceptPhase = (id: string) =>
    dispatchIpcCall(
      'phases:accept',
      getMethodSchema('phases', 'accept'),
      phasesHandlers['accept']!,
      ctx,
      true,
      { id },
    );

  /** Phase 1's only task is done; the Director is asked to review the phase. */
  async function phaseOneDone() {
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
    return { ...had, phaseId, project };
  }

  const review = (phaseId: string, notVerified: string[]) =>
    directorTool('bureau_request_review', {
      phase_id: phaseId,
      summary: 'The menu page is up: every dish with its price.',
      verified: ['menu.html opens and lists the dishes'],
      not_verified: notVerified,
      known_issues: ['The prices are this week’s; they change on Mondays.'],
    });

  async function reviewedPhaseOne() {
    const done = await phaseOneDone();
    const asked = await review(done.phaseId, ['prices against the printed menu']);
    expect(asked.ok, JSON.stringify(asked)).toBe(true);
    director.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    director.pushEvent({ t: 'finished', reason: 'completed', summary: null });
    return done;
  }

  it('the last task done starts a review turn; the review moves phase, project and deliverables, and the card says what was not verified', async () => {
    const { phaseId, project } = await phaseOneDone();
    const turn = director.sentMessages.find((m) => m.text.includes('bureau_request_review'))!;
    expect(turn.text).toContain('Menu');

    // "Not verified" is never left empty: say so, or say "nothing".
    const empty = await review(phaseId, []);
    expect(empty.ok).toBe(false);
    expect(JSON.stringify(empty)).toContain('not_verified');

    const asked = await review(phaseId, ['prices against the printed menu']);
    expect(asked.ok, JSON.stringify(asked)).toBe(true);
    expect(getPhaseById(db, phaseId)!.status).toBe('review');
    expect(getProjectById(db, project.id)!.stage).toBe('review');
    expect(
      db.prepare('SELECT DISTINCT status FROM deliverables WHERE project_id = ?').all(project.id),
    ).toEqual([{ status: 'in_review' }]);
    expect(events('phase.review_requested')).toHaveLength(1);
    expect(events('deliverable.submitted').length).toBeGreaterThan(0);
    const card = db
      .prepare("SELECT payload FROM conversation_messages WHERE kind = 'summary'")
      .get() as { payload: string };
    expect(JSON.parse(card.payload)).toMatchObject({
      phaseId,
      phaseName: 'Menu',
      verified: ['menu.html opens and lists the dishes'],
      notVerified: ['prices against the printed menu'],
      knownIssues: ['The prices are this week’s; they change on Mondays.'],
    });
  });

  it('accepted with the user on base_ref and a clean folder: fast-forwarded, the files appear, and the next phase starts', async () => {
    const { quinn, phaseId, project } = await reviewedPhaseOne();
    const phaseHead = git(project.path, 'rev-parse', 'bureau/phase/1');
    expect(git(project.path, 'symbolic-ref', '--short', 'HEAD')).toBe(project.base_ref);

    const accepted = await acceptPhase(phaseId);
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);

    expect(git(project.path, 'rev-parse', project.base_ref)).toBe(phaseHead);
    expect(readFileSync(path.join(project.path, 'menu.html'), 'utf8')).toContain('Margherita');
    expect(git(project.path, 'status', '--porcelain')).toBe('');
    expect(getPhaseById(db, phaseId)!.status).toBe('done');
    expect(events('phase.accepted')).toHaveLength(1);
    expect(getProjectById(db, project.id)!.stage).toBe('executing');

    // The next phase starts, from the new base.
    await until(
      () =>
        db
          .prepare("SELECT 1 FROM tasks WHERE title = 'Contact page' AND status = 'assigned'")
          .get() !== undefined,
      'the next phase assigned',
    );
    await loop.settled();
    expect(git(project.path, 'rev-parse', 'bureau/phase/2')).toBe(phaseHead);
    expect(
      db.prepare("SELECT assignee_employee_id AS a FROM tasks WHERE title = 'Contact page'").get(),
    ).toEqual({ a: quinn.id });
  });

  it('accepted while the user has uncommitted changes: a blocker says why, and nothing moves', async () => {
    const { phaseId, project } = await reviewedPhaseOne();
    const baseBefore = git(project.path, 'rev-parse', project.base_ref);
    writeFileSync(path.join(project.path, 'notes.txt'), 'my own notes\n');

    const accepted = await acceptPhase(phaseId);
    expect(accepted.ok).toBe(false);
    expect(JSON.stringify(accepted)).toMatch(/uncommitted/);

    expect(git(project.path, 'rev-parse', project.base_ref)).toBe(baseBefore);
    expect(getPhaseById(db, phaseId)!.status).toBe('review');
    const blocker = db
      .prepare("SELECT id FROM checkpoints WHERE type = 'blocker' AND status = 'pending'")
      .get() as { id: string };
    expect(getCheckpointById(db, blocker.id)!.context).toMatch(/uncommitted/);
  });

  it('accepted while the user works on another branch: base_ref moves, their checkout does not', async () => {
    const { phaseId, project } = await reviewedPhaseOne();
    git(project.path, 'switch', '-c', 'my-work');
    const phaseHead = git(project.path, 'rev-parse', 'bureau/phase/1');

    const accepted = await acceptPhase(phaseId);
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);

    expect(git(project.path, 'rev-parse', project.base_ref)).toBe(phaseHead);
    expect(git(project.path, 'symbolic-ref', '--short', 'HEAD')).toBe('my-work');
    expect(() => readFileSync(path.join(project.path, 'menu.html'))).toThrow();
  });

  it('accepted after the user committed to base_ref themselves: a blocker says why, and nothing moves', async () => {
    const { phaseId, project } = await reviewedPhaseOne();
    writeFileSync(path.join(project.path, 'README.md'), 'Luigi\n');
    git(project.path, 'add', 'README.md');
    git(
      project.path,
      '-c',
      'user.name=U',
      '-c',
      'user.email=u@example.com',
      'commit',
      '-m',
      'mine',
    );
    const theirs = git(project.path, 'rev-parse', project.base_ref);

    const accepted = await acceptPhase(phaseId);
    expect(accepted.ok).toBe(false);
    expect(JSON.stringify(accepted)).toMatch(/new commits/);
    expect(git(project.path, 'rev-parse', project.base_ref)).toBe(theirs);
    expect(getPhaseById(db, phaseId)!.status).toBe('review');
  });
});
