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
import {
  getConversationById,
  insertConversation,
} from '../../../src/main/db/repositories/conversations';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { createProject } from '../../../src/main/projects/createProject';
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
 * M11 S2-4, §8.4, risk #9, invariant #2: **`bureau_write_plan`** turns the
 * approved brief into phases, tasks and dependencies — refused unless the
 * brief is approved (`isBriefApproved`), validated in plain code (every
 * task has acceptance criteria, the dependencies are a DAG, every phase
 * index and required skill is real, no phase has more than 15 tasks), and
 * written in **one** transaction so no partial plan can exist. `plan.approve`
 * then moves the project to executing and the Director to `SUPERVISING`.
 *
 * Real chain: the brief written by the real tool and approved through the
 * real `brief.approve`, the real Director on FakeAdapter, the real control
 * channel for the plan.
 */
const BRIEF = {
  title: 'Luigi Trattoria website',
  one_liner: 'A small site where diners see the menu and find the phone number.',
  goal: 'Diners can see what is on tonight and call to book, from their phone.',
  kind: 'software',
  users: 'Diners, mostly on phones.',
  scope: ['A menu page with prices', 'A contact page'],
  non_goals: ['Online booking'],
  deliverables: [
    {
      type: 'repository',
      name: 'Website source',
      description: 'The site.',
      acceptance: ['The menu page shows every dish with its price'],
    },
  ],
  constraints: { tech: [], platform: ['Web'], deadline: null, budget_usd: null, other: [] },
  existing_assets: [],
  success_criteria: ['Diners find the phone number in one tap'],
  assumptions: [],
  open_questions: [],
  risks: [],
};

const task = (title: string, phaseIndex: number, overrides: Record<string, unknown> = {}) => ({
  title,
  body: `Do: ${title}.`,
  acceptance_criteria: [`${title} works on a phone`],
  required_skills: ['code'],
  deliverable_type: 'code',
  phase_index: phaseIndex,
  estimated_cost_usd: 0.4,
  ...overrides,
});

const PLAN = {
  phases: [
    { name: 'Menu page', goal: 'Diners can read the menu.', review_required: true },
    { name: 'Contact page', goal: 'Diners can call.', review_required: true },
  ],
  tasks: [task('Scaffold the site', 0), task('Menu page', 0), task('Contact page', 1)],
  deps: [
    { task_index: 1, depends_on_index: 0 },
    { task_index: 2, depends_on_index: 0 },
  ],
};

describe('bureau_write_plan: one transaction, validated, only after the brief is approved', () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-write-plan-'));
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

  const counts = (projectId: string) => ({
    plans: (
      db.prepare('SELECT COUNT(*) AS n FROM plans WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n,
    phases: (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)',
        )
        .get(projectId) as { n: number }
    ).n,
    tasks: (
      db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n,
    deps: (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM task_deps WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
        )
        .get(projectId) as { n: number }
    ).n,
  });

  /** A project whose brief is written, and optionally approved. */
  async function project(
    approved: boolean,
  ): Promise<{ projectId: string; conversationId: string }> {
    const company = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Test Co',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
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
    if (approved) {
      const briefId = (
        db.prepare('SELECT id FROM briefs WHERE project_id = ?').get(created.project.id) as {
          id: string;
        }
      ).id;
      expect((await ipc('brief', 'approve', { id: briefId })).ok).toBe(true);
    }
    await inDirectorTurn(db, supervisorRegistry, created.conversation.id);
    return { projectId: created.project.id, conversationId: created.conversation.id };
  }

  it('is refused until the brief is approved, and writes nothing', async () => {
    const { projectId } = await project(false);
    const result = await tool('bureau_write_plan', PLAN);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/brief is approved/);
    expect(counts(projectId)).toEqual({ plans: 0, phases: 0, tasks: 0, deps: 0 });
  });

  it('is refused once the approved brief has been edited, until the new version is approved', async () => {
    const { projectId } = await project(true);
    const briefId = (
      db.prepare('SELECT id FROM briefs WHERE project_id = ?').get(projectId) as { id: string }
    ).id;
    expect(
      (await ipc('brief', 'saveEdit', { id: briefId, markdown: '# Now with a gallery' })).ok,
    ).toBe(true);
    const result = await tool('bureau_write_plan', PLAN);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/brief is approved/);
    expect(counts(projectId)).toEqual({ plans: 0, phases: 0, tasks: 0, deps: 0 });
  });

  it('writes the plan, its phases, tasks and dependencies, posts the card, and waits for approval', async () => {
    const { projectId, conversationId } = await project(true);

    const result = await tool('bureau_write_plan', PLAN);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(counts(projectId)).toEqual({ plans: 1, phases: 2, tasks: 3, deps: 2 });
    const plan = db
      .prepare(
        'SELECT status, version, estimated_cost_usd_micros AS cost FROM plans WHERE project_id = ?',
      )
      .get(projectId);
    expect(plan).toEqual({ status: 'awaiting_approval', version: 1, cost: 1_200_000 });
    expect(getConversationById(db, conversationId)!.director_state).toBe('AWAITING_PLAN_APPROVAL');
    expect(events('project.plan_drafted')).toHaveLength(1);
    expect(events('task.created')).toHaveLength(3);
    const card = db
      .prepare(
        "SELECT payload FROM conversation_messages WHERE conversation_id = ? AND kind = 'plan'",
      )
      .get(conversationId) as { payload: string };
    expect(JSON.parse(card.payload)).toMatchObject({
      estimatedCostMicros: 1_200_000,
      phases: [
        {
          name: 'Menu page',
          estimatedCostMicros: 800_000,
          tasks: [{ title: 'Scaffold the site' }, { title: 'Menu page' }],
        },
        { name: 'Contact page', estimatedCostMicros: 400_000, tasks: [{ title: 'Contact page' }] },
      ],
    });
  });

  const refused = async (plan: unknown, why: RegExp) => {
    const { projectId, conversationId } = await project(true);
    const result = await tool('bureau_write_plan', plan as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(why);
    expect(counts(projectId)).toEqual({ plans: 0, phases: 0, tasks: 0, deps: 0 });
    expect(getConversationById(db, conversationId)!.director_state).toBe('PLANNING');
  };

  it('refuses a task with no acceptance criteria', async () => {
    await refused(
      { ...PLAN, tasks: [task('Vague', 0, { acceptance_criteria: [] }), ...PLAN.tasks.slice(1)] },
      /acceptance_criteria/,
    );
  });

  it('refuses a dependency cycle, and names it', async () => {
    await refused(
      {
        ...PLAN,
        deps: [
          { task_index: 1, depends_on_index: 2 },
          { task_index: 2, depends_on_index: 1 },
        ],
      },
      /cycle.*task 1.*task 2|cycle.*task 2.*task 1/,
    );
  });

  it('refuses a phase index that is not one of the phases', async () => {
    await refused({ ...PLAN, tasks: [...PLAN.tasks, task('Nowhere', 5)] }, /phase_index 5/);
  });

  it('refuses a skill no role has', async () => {
    await refused(
      { ...PLAN, tasks: [...PLAN.tasks, task('Juggle', 1, { required_skills: ['juggling'] })] },
      /juggling/,
    );
  });

  it('refuses a phase of more than 15 tasks: "the phase is really two"', async () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => task(`Task ${i}`, 0));
    await refused({ ...PLAN, tasks: sixteen, deps: [] }, /really two/);
  });

  it('is one transaction: a task that cannot be written leaves no plan behind', async () => {
    const { projectId, conversationId } = await project(true);
    db.exec(`CREATE TEMP TRIGGER fail_third_task BEFORE INSERT ON tasks
      WHEN (SELECT COUNT(*) FROM tasks WHERE project_id = NEW.project_id) >= 2
      BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);

    const result = await tool('bureau_write_plan', PLAN);

    expect(result.ok).toBe(false);
    expect(counts(projectId)).toEqual({ plans: 0, phases: 0, tasks: 0, deps: 0 });
    expect(getConversationById(db, conversationId)!.director_state).toBe('PLANNING');
    expect(events('project.plan_drafted')).toEqual([]);
    expect(events('task.created')).toEqual([]);
  });

  it('plan.approve: executing, SUPERVISING, the plan is the project’s, and the Director is told', async () => {
    const { projectId, conversationId } = await project(true);
    expect((await tool('bureau_write_plan', PLAN)).ok).toBe(true);
    adapter.pushEvent({ t: 'finished', reason: 'completed', summary: null });
    const planId = (
      db.prepare('SELECT id FROM plans WHERE project_id = ?').get(projectId) as { id: string }
    ).id;
    const sentBefore = adapter.sentMessages.length;

    expect((await ipc('plan', 'approve', { id: planId })).ok).toBe(true);

    expect(getProjectById(db, projectId)).toMatchObject({ stage: 'executing', plan_id: planId });
    expect(getConversationById(db, conversationId)!.director_state).toBe('SUPERVISING');
    expect(events('project.plan_approved')).toHaveLength(1);
    const deadline = Date.now() + 5_000;
    while (adapter.sentMessages.length === sentBefore && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(adapter.sentMessages.at(-1)!.text).toMatch(/approved the plan/i);
  });

  it('a new version after changes were asked for replaces the old one, and cancels its tasks', async () => {
    const { projectId } = await project(true);
    expect((await tool('bureau_write_plan', PLAN)).ok).toBe(true);
    const first = (
      db.prepare('SELECT id FROM plans WHERE project_id = ?').get(projectId) as { id: string }
    ).id;
    expect(
      (await ipc('plan', 'requestEdit', { id: first, feedback: 'Contact page first.' })).ok,
    ).toBe(true);

    expect((await tool('bureau_write_plan', PLAN)).ok).toBe(true);

    expect(
      db
        .prepare('SELECT version, status FROM plans WHERE project_id = ? ORDER BY version')
        .all(projectId),
    ).toEqual([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'awaiting_approval' },
    ]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = 'cancelled'")
        .get(projectId),
    ).toEqual({ n: 3 });
    expect(events('task.cancelled')).toHaveLength(3);
  });
});
