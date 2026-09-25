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
  setConversationDirectorState,
} from '../../../src/main/db/repositories/conversations';
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
import { seedBrief, seedPlan } from '../../helpers/dbFixtures';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S2-3b, `NEXT-VERSION` §L.4: **asking for changes to a brief or a plan
 * is a real state change**, with its own §5.2 event
 * (`project.brief_changes_requested` / `project.plan_changes_requested`),
 * and the feedback reaches the Director as a turn. The Director goes back
 * to drafting (A.3: `AWAITING_BRIEF_APPROVAL → DRAFTING_BRIEF`,
 * `AWAITING_PLAN_APPROVAL → PLANNING`), and the user's words are in the
 * conversation for them to see.
 *
 * Real chain: `brief.requestEdit` / `plan.requestEdit` through
 * `dispatchIpcCall`, the real trigger queue, the real Director on FakeAdapter.
 */
describe('asking for changes to a brief or a plan', () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-request-changes-'));
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

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** A project whose Director waits on the given approval. */
  function waitingOn(state: 'AWAITING_BRIEF_APPROVAL' | 'AWAITING_PLAN_APPROVAL') {
    const company = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Test Co',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
    const { project, conversation } = createProject(
      { db, activityLog },
      {
        companyId,
        name: 'Luigi Trattoria',
        conversation: { bind: company.id },
        actor: 'user',
        reason: 'test',
      },
    );
    setConversationDirectorState(db, conversation.id, state, {});
    return { projectId: project.id, conversationId: conversation.id };
  }

  const call = (namespace: 'brief' | 'plan', input: unknown) =>
    dispatchIpcCall(
      `${namespace}:requestEdit`,
      getMethodSchema(namespace, 'requestEdit'),
      (namespace === 'brief' ? briefHandlers : planHandlers)['requestEdit']!,
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

  const userMessages = (conversationId: string) =>
    (
      db
        .prepare(
          "SELECT body FROM conversation_messages WHERE conversation_id = ? AND author = 'user'",
        )
        .all(conversationId) as { body: string }[]
    ).map((row) => row.body);

  it('brief.requestEdit: one event, the Director back to drafting, the words in the chat, and a turn', async () => {
    const { projectId, conversationId } = waitingOn('AWAITING_BRIEF_APPROVAL');
    const brief = seedBrief(db, { project_id: projectId, status: 'awaiting_approval' } as never);

    const result = await call('brief', { id: brief.id, feedback: 'Add a photo gallery.' });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(events('project.brief_changes_requested').map((e) => e.payload)).toEqual([
      expect.objectContaining({ briefId: brief.id, version: brief.version }),
    ]);
    expect(getConversationById(db, conversationId)!.director_state).toBe('DRAFTING_BRIEF');
    expect(userMessages(conversationId).join('\n')).toContain('Add a photo gallery.');
    await until(() => adapter.sentMessages.length === 1, 'the Director’s turn');
    expect(adapter.sentMessages[0]!.text).toContain('Add a photo gallery.');
    expect(adapter.sentMessages[0]!.text).toMatch(/bureau_write_brief/);
  });

  it('plan.requestEdit: the same, back to planning', async () => {
    const { projectId, conversationId } = waitingOn('AWAITING_PLAN_APPROVAL');
    const plan = seedPlan(db, { project_id: projectId, status: 'awaiting_approval' } as never);

    const result = await call('plan', { id: plan.id, feedback: 'Put the menu page first.' });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(events('project.plan_changes_requested').map((e) => e.payload)).toEqual([
      expect.objectContaining({ planId: plan.id, version: plan.version }),
    ]);
    expect(getConversationById(db, conversationId)!.director_state).toBe('PLANNING');
    await until(() => adapter.sentMessages.length === 1, 'the Director’s turn');
    expect(adapter.sentMessages[0]!.text).toContain('Put the menu page first.');
  });

  it('refuses changes to a version that is not waiting for approval, and changes nothing', async () => {
    const { projectId, conversationId } = waitingOn('AWAITING_BRIEF_APPROVAL');
    const approved = seedBrief(db, { project_id: projectId, status: 'approved' } as never);

    const result = await call('brief', { id: approved.id, feedback: 'Too late?' });

    expect(result.ok).toBe(false);
    expect(events('project.brief_changes_requested')).toEqual([]);
    expect(getConversationById(db, conversationId)!.director_state).toBe('AWAITING_BRIEF_APPROVAL');
    expect(userMessages(conversationId)).toEqual([]);
  });
});
