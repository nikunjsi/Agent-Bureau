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
import { getCheckpointById } from '../../../src/main/db/repositories/checkpoints';
import { insertOutboxMessage } from '../../../src/main/db/repositories/messages';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
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
 * M11 S3-3, §8.5, §9.7, `NEXT-VERSION` §J.3: **work nobody hired can take.**
 * A ready task with nobody eligible waits with its reason recorded, and the
 * Director is told — once — whether a hire could fix it. A message held
 * because nobody in its role is free reaches the Director too.
 * `bureau_hire_proposal` raises a `decision` checkpoint that states the cost;
 * accepting it hires through the real `hireEmployee`, and the loop gives the
 * waiting task to the new hire. With no role that could take it, the Director
 * is told to explain. The plan card lists the hires the plan needs.
 *
 * Real chain: the Director's tools over the real control channel, the real
 * IPC, the real loop and router; employees on FakeAdapter.
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

const task = (title: string, skills: string[], cost: number) => ({
  title,
  body: `Do: ${title}.`,
  acceptance_criteria: [`${title} works`],
  required_skills: skills,
  deliverable_type: 'code',
  phase_index: 0,
  estimated_cost_usd: cost,
});

const PLAN = {
  phases: [{ name: 'Site', goal: 'A site.', review_required: true }],
  tasks: [task('Menu page', ['code'], 0.4), task('Test plan', ['testing'], 0.3)],
  deps: [],
};

describe('work nobody hired can take', () => {
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
  let employeeAdapters: Map<string, FakeAdapter>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-unfillable-'));
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
    // Coalesced triggers go at once here, rather than after 20 s.
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

  const ipc = (namespace: 'brief' | 'plan' | 'checkpoints', method: string, input: unknown) =>
    dispatchIpcCall(
      `${namespace}:${method}`,
      getMethodSchema(namespace, method),
      (namespace === 'brief'
        ? briefHandlers
        : namespace === 'plan'
          ? planHandlers
          : checkpointsHandlers)[method]!,
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

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** The end of a scripted Director turn, so the next may go. */
  const endTurn = () => {
    director.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    director.pushEvent({ t: 'finished', reason: 'completed', summary: null });
  };

  const hire = (roleKey: string, name: string) =>
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey, name }).employee;

  async function plannedProject(plan: unknown = PLAN) {
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
    expect((await tool('bureau_write_plan', plan as Record<string, unknown>)).ok).toBe(true);
    endTurn();
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

  /** Approve, let the approval's own Director turn end, and let the loop run. */
  async function approve(planId: string): Promise<void> {
    const before = director.sentMessages.length;
    expect((await ipc('plan', 'approve', { id: planId })).ok).toBe(true);
    await until(() => director.sentMessages.length > before, 'the approval turn');
    endTurn();
    await loop.settled();
  }

  it('the plan card names the hire the plan needs, with the cost of the work waiting for it', async () => {
    hire('engineering:developer', 'Quinn');
    await plannedProject();
    const card = db
      .prepare("SELECT payload FROM conversation_messages WHERE kind = 'plan'")
      .get() as { payload: string };
    const hires = (JSON.parse(card.payload) as { hiresNeeded: string[] }).hiresNeeded;
    expect(hires).toHaveLength(1);
    expect(hires[0]).toContain('Tester (engineering:tester)');
    expect(hires[0]).toContain('for 1 task');
    expect(hires[0]).toContain('$0.30');
  });

  it('a ready task nobody can take waits with its reason, and the Director is told a hire could fix it, once', async () => {
    hire('engineering:developer', 'Quinn');
    const { planId, byTitle } = await plannedProject();
    await approve(planId);

    await until(() => employeeAdapters.size === 1, 'the developer started');
    await loop.settled();
    const waiting = getTaskById(db, byTitle('Test plan'))!;
    expect(waiting.status).toBe('queued');
    expect(waiting.status_reason).toContain('Tester (engineering:tester)');
    expect(events('task.waiting')).toHaveLength(1);

    await until(
      () => director.sentMessages.some((m) => m.text.includes('bureau_hire_proposal')),
      'the Director told',
    );
    const told = director.sentMessages.find((m) => m.text.includes('bureau_hire_proposal'))!;
    expect(told.text).toContain('Test plan');
    expect(told.text).toContain('engineering:tester');

    // Another pass finds the same reason: nothing new is recorded or sent.
    const sent = director.sentMessages.length;
    loop.kick();
    await loop.settled();
    expect(events('task.waiting')).toHaveLength(1);
    expect(director.sentMessages.length).toBe(sent);
  });

  it('the proposal states the cost, and accepting it hires a Tester who is given the task', async () => {
    hire('engineering:developer', 'Quinn');
    const { projectId, planId, byTitle } = await plannedProject();
    await approve(planId);
    await until(
      () => director.sentMessages.some((m) => m.text.includes('bureau_hire_proposal')),
      'the Director told',
    );

    // The Director's scripted reply: propose the hire.
    director.pushEvent({ t: 'turn.started', turnIndex: 0 });
    const proposed = await tool('bureau_hire_proposal', {
      role_key: 'engineering:tester',
      reason: 'The test plan needs someone who writes tests.',
      estimated_monthly_cost_usd: 12.5,
    });
    expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
    endTurn();
    const checkpointId = (proposed as unknown as { data: { checkpointId: string } }).data
      .checkpointId;
    const checkpoint = getCheckpointById(db, checkpointId)!;
    expect(checkpoint).toMatchObject({
      type: 'decision',
      project_id: projectId,
      default_action: 'not_now',
    });
    expect(checkpoint.context).toContain('$12.50');
    expect(checkpoint.options!.find((o) => o.id === 'hire')!.consequence).toContain('$12.50');
    expect(checkpoint.options!.find((o) => o.id === 'not_now')!.reversible).toBe(true);

    const hiredBefore = events('company.employee_hired').length;
    expect((await ipc('checkpoints', 'answer', { id: checkpointId, optionId: 'hire' })).ok).toBe(
      true,
    );
    expect(events('company.employee_hired')).toHaveLength(hiredBefore + 1);
    const tester = db
      .prepare("SELECT id FROM employees WHERE role_key = 'engineering:tester'")
      .get() as { id: string };
    expect(tester).toBeDefined();

    await until(() => employeeAdapters.has(tester.id), 'the Tester started');
    await loop.settled();
    expect(getTaskById(db, byTitle('Test plan'))).toMatchObject({
      status: 'assigned',
      assignee_employee_id: tester.id,
      status_reason: null,
    });
  });

  it('with no role that could take it, the task waits and the Director is told to explain why', async () => {
    hire('engineering:developer', 'Quinn');
    const { planId, byTitle } = await plannedProject();
    // A skill no installed role has (the plan's own check refuses one at
    // write time; a pack uninstalled since is how it happens).
    db.prepare('UPDATE tasks SET required_skills = \'["welding"]\' WHERE id = ?').run(
      byTitle('Test plan'),
    );
    await approve(planId);

    await until(
      () => director.sentMessages.some((m) => m.text.includes('Tell the user plainly')),
      'the Director told to explain',
    );
    const waiting = getTaskById(db, byTitle('Test plan'))!;
    expect(waiting.status).toBe('queued');
    expect(waiting.status_reason).toContain('No role in the installed packs has the skills');
    expect(waiting.status_reason).toContain('welding');
  });

  it('a message for a role nobody holds is held, and the Director hears of it', async () => {
    const quinn = hire('engineering:developer', 'Quinn');
    insertOutboxMessage(db, {
      idempotency_key: 'k-1',
      from_addr: `employee:${quinn.id}`,
      to_addr: 'role:engineering:tester',
      kind: 'handoff',
      subject: 'Tests',
      body: 'Please write the tests for the menu page.',
    });
    const report = await routeOnce(
      { db, activityLog, supervisorRegistry, appStartedAtMs: 0, directorTriggers: triggers },
      { nowMs: Date.now() },
    );
    expect(report.held.map((h) => h.reason)).toContain('no_idle_employee_for_role');
    await until(
      () => director.sentMessages.some((m) => m.text.includes('role:engineering:tester')),
      'the Director told',
    );
    const told = director.sentMessages.find((m) => m.text.includes('role:engineering:tester'))!;
    expect(told.text).toContain('nobody in the engineering:tester role is hired');
  });

  it('a proposal for a role that is not installed is refused', async () => {
    const { projectId } = await plannedProject();
    void projectId;
    const refused = await tool('bureau_hire_proposal', {
      role_key: 'engineering:astronaut',
      reason: 'Space.',
      estimated_monthly_cost_usd: 1,
    });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('no installed role engineering:astronaut');
  });
});
