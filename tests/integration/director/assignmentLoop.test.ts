import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { getProjectById } from '../../../src/main/db/repositories/projects';
import { getTaskById, setTaskStatus } from '../../../src/main/db/repositories/tasks';
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
 * M11 S3-2b, §26.2, §10.6 rules 1–2: **the autonomous assignment loop**, in
 * plain code. `plan.approve` starts it; it takes the ready set (`readyTasks`,
 * S3-0 — the current phase only), filters by §8.5 (`eligibleEmployees`,
 * S3-2a), picks by the key, claims (`claimTask`), makes the project's folder
 * a repository (`ensureProjectWorkspace`), starts the phase on
 * `bureau/phase/<n>` from `base_ref`, points the employee's worktree at a task
 * branch cut from it, and starts the employee through the production chain
 * (`createEmployeeAdapter`, `composeEmployeeContext`, `Supervisor.assign()`),
 * with **no Director turn per assignment**.
 *
 * Real chain: the Director's tools over the real control channel, the real
 * IPC approvals, real git. Employees run on FakeAdapter through the loop's
 * adapter seam; everything else is production code.
 */
const brief = (existingAssets: string[] = []) => ({
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
  existing_assets: existingAssets,
  success_criteria: ['It loads'],
  assumptions: [],
  open_questions: [],
  risks: [],
});

const task = (title: string, phaseIndex: number) => ({
  title,
  body: `Do: ${title}.`,
  acceptance_criteria: [`${title} works`],
  required_skills: ['code'],
  deliverable_type: 'code',
  phase_index: phaseIndex,
  estimated_cost_usd: 0.1,
});

const PLAN = {
  phases: [
    { name: 'Pages', goal: 'The pages.', review_required: true },
    { name: 'Launch', goal: 'Live.', review_required: true },
  ],
  tasks: [task('Menu page', 0), task('Contact page', 0), task('Styles', 0), task('Go live', 1)],
  deps: [{ task_index: 2, depends_on_index: 0 }],
};

describe('the assignment loop', () => {
  let tmpDir: string;
  let baseDir: string;
  let homeDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let supervisorRegistry: SupervisorRegistry;
  let tokenRegistry: TokenRegistry;
  let server: ControlChannelServer;
  let triggers: DirectorTriggers;
  let ctx: HandlerContext;
  let director: FakeAdapter;
  let loop: AssignmentLoop;
  let employeeAdapters: Map<string, FakeAdapter>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-loop-'));
    baseDir = path.join(tmpDir, 'userData');
    homeDir = path.join(tmpDir, 'home');
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
    companyId = seedCompany(db, homeDir).id;
    installShippedPack({ db, activityLog, baseDir, packKey: 'operations' });
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });
    supervisorRegistry = new SupervisorRegistry();
    tokenRegistry = new TokenRegistry();
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
      // The one seam: employees run on scripted output.
      createAdapter: (_db: Database.Database, employee: Employee) => {
        const adapter = new FakeAdapter({ keepOpen: true });
        employeeAdapters.set(employee.id, adapter);
        return adapter;
      },
    });
  });

  afterEach(async () => {
    loop.stop();
    triggers.stop();
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const tool = (name: string, args: Record<string, unknown>) =>
    callBureauTool(director.startedContext!.controlChannel, name, args);

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

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const hire = (name: string) =>
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'engineering:developer', name })
      .employee;

  /** A planned project; the plan is written and waiting for the user. */
  async function plannedProject(existingAssets: string[] = []) {
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
    expect((await tool('bureau_write_brief', { brief: brief(existingAssets) })).ok).toBe(true);
    const briefId = (
      db.prepare('SELECT id FROM briefs WHERE project_id = ?').get(created.project.id) as {
        id: string;
      }
    ).id;
    expect((await ipc('brief', 'approve', { id: briefId })).ok).toBe(true);
    await inDirectorTurn(db, supervisorRegistry, created.conversation.id);
    expect((await tool('bureau_write_plan', PLAN)).ok).toBe(true);
    director.pushEvent({ t: 'finished', reason: 'completed', summary: null });
    const planId = (
      db.prepare('SELECT id FROM plans WHERE project_id = ?').get(created.project.id) as {
        id: string;
      }
    ).id;
    const byTitle = (title: string) =>
      (
        db
          .prepare('SELECT id FROM tasks WHERE project_id = ? AND title = ?')
          .get(created.project.id, title) as { id: string }
      ).id;
    return { projectId: created.project.id, planId, byTitle };
  }

  it('approving the plan starts the work: the phase branch, a task branch each, both employees started, and no Director turn for it', async () => {
    const quinn = hire('Quinn');
    const zeb = hire('Zeb');
    // A third, free all along: nothing in the next phase, or behind a
    // dependency, is ready for her.
    const barnaby = hire('Barnaby');
    const { projectId, planId, byTitle } = await plannedProject();
    await loop.settled();
    // Nothing is assigned before the user approves the plan.
    expect(employeeAdapters.size).toBe(0);

    const directorTurnsBefore = director.sentMessages.length;
    expect((await ipc('plan', 'approve', { id: planId })).ok).toBe(true);
    await until(() => employeeAdapters.size === 2, 'both employees started');
    await until(
      () => [...employeeAdapters.values()].every((a) => a.sentMessages.length > 0),
      'each got its task',
    );
    await loop.settled();

    // Hire order picks: Quinn the first ready task, Zeb the second.
    expect(getTaskById(db, byTitle('Menu page'))).toMatchObject({
      status: 'assigned',
      assignee_employee_id: quinn.id,
    });
    expect(getTaskById(db, byTitle('Contact page'))!.assignee_employee_id).toBe(zeb.id);
    // A dependency, and the next phase, wait.
    expect(getTaskById(db, byTitle('Styles'))!.status).toBe('queued');
    expect(getTaskById(db, byTitle('Go live'))!.status).toBe('queued');
    expect(getEmployeeById(db, barnaby.id)!.current_task_id).toBeNull();
    expect(employeeAdapters.get(quinn.id)!.sentMessages[0]!.text).toContain('Menu page');

    // Rule 1: the phase started on its own branch, from base_ref.
    const project = getProjectById(db, projectId)!;
    expect(git(project.path, 'rev-parse', 'bureau/phase/1')).toBe(
      git(project.path, 'rev-parse', project.base_ref),
    );
    expect(events('phase.started')).toHaveLength(1);
    // Rule 2: each task branch is cut from the phase branch.
    const worktree = getWorktreeById(db, getEmployeeById(db, quinn.id)!.worktree_id!)!;
    expect(worktree.branch).toMatch(/^bureau\/quinn\/T-\d+$/);
    expect(worktree.base_commit).toBe(git(project.path, 'rev-parse', 'bureau/phase/1'));
    expect(existsSync(worktree.path)).toBe(true);

    // No Director turn per assignment: only the approval's own turn.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(director.sentMessages.length - directorTurnsBefore).toBe(1);
    expect(director.sentMessages.at(-1)!.text).toMatch(/approved the plan/i);
  });

  it('orchestrator.maxConcurrentEmployees caps how many run at once', async () => {
    setSetting(db, 'orchestrator.maxConcurrentEmployees', 1);
    hire('Quinn');
    hire('Zeb');
    const { planId } = await plannedProject();
    expect((await ipc('plan', 'approve', { id: planId })).ok).toBe(true);
    await until(() => employeeAdapters.size === 1, 'one employee started');
    await loop.settled();
    loop.kick();
    await loop.settled();
    expect(employeeAdapters.size).toBe(1);
    expect(events('task.assigned')).toHaveLength(1);
  });

  it('a worktree deleted between tasks is made again before the next one', async () => {
    setSetting(db, 'orchestrator.maxConcurrentEmployees', 1);
    const quinn = hire('Quinn');
    const { planId, byTitle } = await plannedProject();
    expect((await ipc('plan', 'approve', { id: planId })).ok).toBe(true);
    await until(() => employeeAdapters.size === 1, 'Quinn started');
    await loop.settled();
    const first = getWorktreeById(db, getEmployeeById(db, quinn.id)!.worktree_id!)!;

    // Quinn finishes the menu page and stops; the worktree folder is lost.
    await supervisorRegistry.get(quinn.id)!.stop();
    setTaskStatus(db, byTitle('Menu page'), 'done');
    rmSync(first.path, { recursive: true, force: true });
    expect(existsSync(first.path)).toBe(false);

    loop.kick();
    await loop.settled();

    const next = db
      .prepare("SELECT title FROM tasks WHERE assignee_employee_id = ? AND status = 'assigned'")
      .get(quinn.id) as { title: string };
    expect(['Contact page', 'Styles']).toContain(next.title);
    const worktree = getWorktreeById(db, getEmployeeById(db, quinn.id)!.worktree_id!)!;
    expect(existsSync(worktree.path)).toBe(true);
    expect(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(worktree.branch);
    const released = events('git.worktree_released');
    expect(released).toHaveLength(1);
    expect(released[0]!.payload).toMatchObject({ reason: 'missing_on_disk', path: first.path });
  });

  it('a folder that cannot be made ready blocks the task with the reason, and frees the employee', async () => {
    const missing = path.join(tmpDir, 'not-there');
    const quinn = hire('Quinn');
    const { planId, byTitle } = await plannedProject([missing]);
    expect((await ipc('plan', 'approve', { id: planId })).ok).toBe(true);
    await until(() => events('task.blocked').length > 0, 'the task blocked');
    await loop.settled();

    const blocked = getTaskById(db, byTitle('Menu page'))!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.status_reason).toContain(missing);
    expect(blocked.assignee_employee_id).toBeNull();
    expect(getEmployeeById(db, quinn.id)!.current_task_id).toBeNull();
    expect(employeeAdapters.size).toBe(0);
  });
});
