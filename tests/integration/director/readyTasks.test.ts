import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { createProject } from '../../../src/main/projects/createProject';
import { readyTasks, taskNotReadyReason } from '../../../src/main/projects/readyTasks';
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
 * M11 S3-0 (1), §F S2-4, invariant #2: `bureau_write_plan` writes a plan's
 * tasks as `queued` before the user approves it (`tasks.status` has no draft
 * value). The one function that says which tasks may be assigned — the loop
 * and `bureau_assign_task` both ask it (S3-2) — requires the task's plan to
 * be **approved and current**: the project's `plan_id`, with status
 * `approved`. Before approval nothing is ready; after, the tasks with no
 * unfinished dependency are; a replaced version's tasks never are.
 *
 * Real chain: the brief and plan written by the real Director tools over the
 * real control channel, approved through the real IPC handlers.
 */
const BRIEF = {
  title: 'Luigi Trattoria website',
  one_liner: 'A small site where diners see the menu and find the phone number.',
  goal: 'Diners can see what is on tonight and call to book, from their phone.',
  kind: 'software',
  users: 'Diners, mostly on phones.',
  scope: ['A menu page with prices'],
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

const task = (title: string) => ({
  title,
  body: `Do: ${title}.`,
  acceptance_criteria: [`${title} works on a phone`],
  required_skills: ['code'],
  deliverable_type: 'code',
  phase_index: 0,
  estimated_cost_usd: 0.4,
});

const PLAN = {
  phases: [{ name: 'Menu page', goal: 'Diners can read the menu.', review_required: true }],
  tasks: [task('Scaffold the site'), task('Menu page'), task('Styles')],
  deps: [{ task_index: 1, depends_on_index: 0 }],
};

describe('only an approved, current plan’s tasks are ever ready to assign', () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-ready-tasks-'));
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

  /** A project with an approved brief and a written, unapproved plan. */
  async function plannedProject(): Promise<{ projectId: string; planId: string }> {
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
      db
        .prepare("SELECT id FROM plans WHERE project_id = ? AND status = 'awaiting_approval'")
        .get(created.project.id) as { id: string }
    ).id;
    return { projectId: created.project.id, planId };
  }

  const titles = (projectId: string) =>
    readyTasks(db, projectId)
      .map((t) => t.title)
      .sort();

  const taskId = (title: string, planId: string) =>
    (
      db
        .prepare(
          'SELECT t.id FROM tasks t JOIN phases p ON p.id = t.phase_id WHERE p.plan_id = ? AND t.title = ?',
        )
        .get(planId, title) as { id: string }
    ).id;

  it('a written plan’s queued tasks are not ready until the user approves it', async () => {
    const { projectId, planId } = await plannedProject();
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = 'queued'")
        .get(projectId),
    ).toEqual({ n: 3 });

    expect(titles(projectId)).toEqual([]);
    expect(taskNotReadyReason(db, taskId('Styles', planId))).toMatch(/not approved/);

    expect((await ipc('plan', 'approve', { id: planId })).ok).toBe(true);

    // The two with no unfinished dependency; the menu page waits on the scaffold.
    expect(titles(projectId)).toEqual(['Scaffold the site', 'Styles']);
    expect(taskNotReadyReason(db, taskId('Styles', planId))).toBeNull();
    expect(taskNotReadyReason(db, taskId('Menu page', planId))).toMatch(/waits on/);
  });

  it('a replaced version’s tasks are never ready, even if something leaves them queued', async () => {
    const { projectId, planId: first } = await plannedProject();
    expect((await ipc('plan', 'requestEdit', { id: first, feedback: 'Styles first.' })).ok).toBe(
      true,
    );
    expect((await tool('bureau_write_plan', PLAN)).ok).toBe(true);
    const second = (
      db
        .prepare("SELECT id FROM plans WHERE project_id = ? AND status = 'awaiting_approval'")
        .get(projectId) as { id: string }
    ).id;
    expect((await ipc('plan', 'approve', { id: second })).ok).toBe(true);

    // The replaced version's tasks were cancelled; put them back to queued, so
    // what keeps them out is the plan, not their status.
    db.prepare(
      "UPDATE tasks SET status = 'queued' WHERE phase_id IN (SELECT id FROM phases WHERE plan_id = ?)",
    ).run(first);

    const ready = readyTasks(db, projectId);
    expect(ready).toHaveLength(2);
    const secondPhases = (
      db.prepare('SELECT id FROM phases WHERE plan_id = ?').all(second) as { id: string }[]
    ).map((p) => p.id);
    for (const t of ready) expect(secondPhases).toContain(t.phase_id);
    expect(taskNotReadyReason(db, taskId('Styles', first))).toMatch(
      /not the project's current plan/,
    );
  });
});
