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
import { ChatStreamRegistry } from '../../../src/main/chat/chatStream';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { routeOnce } from '../../../src/main/messages/router';
import { getDbPaths } from '../../../src/main/db/paths';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { Conversation } from '../../../src/shared/models/conversation';
import { seedProject } from '../../helpers/dbFixtures';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { inDirectorTurn } from '../../helpers/directorTurn';
import { createProject } from '../../../src/main/projects/createProject';
import { insertConversationMessage } from '../../../src/main/db/repositories/conversationMessages';
import { projectsHandlers } from '../../../src/main/ipc/handlers/projects';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S2-1b: **a project is created from the chat.** The user never has to
 * "create a project" first (§5.1): new work described in the company
 * conversation becomes a project in one transaction — the project at stage
 * `intake`, the conversation it was said in bound to it, and a fresh
 * company conversation so there is always one (Nikunj's decision,
 * 2026-09-25). New work described inside a project's conversation creates
 * nothing: the Director is told to offer it as a new project.
 *
 * Real chain: `chat.send`, the router, the trigger queue, the intent
 * classifier (rules: no provider is configured), `startDirector`'s
 * Supervisor on FakeAdapter.
 */
describe('a project created from the chat', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let supervisorRegistry: SupervisorRegistry;
  let tokenRegistry: TokenRegistry;
  let server: ControlChannelServer;
  let triggers: DirectorTriggers;
  let ctx: HandlerContext;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-project-from-chat-'));
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
      chatStreams: new ChatStreamRegistry({ db, activityLog }),
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

  function conversation(projectId: string | null): Conversation {
    return insertConversation(db, {
      company_id: companyId,
      project_id: projectId,
      title: 'Test Co',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
  }

  async function say(conversationId: string, body: string): Promise<void> {
    const result = await dispatchIpcCall(
      'chat:send',
      getMethodSchema('chat', 'send'),
      chatHandlers['send']!,
      ctx,
      true,
      { conversationId, body },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await routeOnce(
      { db, activityLog, supervisorRegistry, appStartedAtMs: 0, directorTriggers: triggers },
      { nowMs: Date.now() },
    );
  }

  const events = (type: string) =>
    readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            project_id: string | null;
            payload: Record<string, unknown>;
          },
      )
      .filter((event) => event.type === type);

  const projects = () =>
    db.prepare('SELECT id, name, stage, path FROM projects ORDER BY created_at').all() as {
      id: string;
      name: string;
      stage: string;
      path: string;
    }[];

  it('new work in the company conversation: one project at intake, this conversation bound to it, a fresh company conversation', async () => {
    const company = conversation(null);

    await say(company.id, 'Build me a website for my bakery');
    await until(() => adapter.sentMessages.length === 1, 'the turn');

    const created = projects();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'A website for my bakery', stage: 'intake' });
    expect(created[0]!.path).toBe(path.join(tmpDir, 'home', 'a-website-for-my-bakery'));

    // The conversation it was said in is now the project's, mid-intake.
    const bound = getConversationById(db, company.id)!;
    expect(bound.project_id).toBe(created[0]!.id);
    expect(bound.title).toBe('A website for my bakery');
    expect(bound.director_state).toBe('INTAKE');

    // And there is still one company-level conversation, fresh and idle.
    const companyLevel = db
      .prepare('SELECT id, director_state FROM conversations WHERE project_id IS NULL')
      .all() as { id: string; director_state: string | null }[];
    expect(companyLevel).toHaveLength(1);
    expect(companyLevel[0]!.id).not.toBe(company.id);
    expect(companyLevel[0]!.director_state).toBeNull();

    // One event each, and the project's own.
    expect(events('project.created').map((e) => e.project_id)).toEqual([created[0]!.id]);
    expect(events('director.intake_started').map((e) => e.project_id)).toEqual([created[0]!.id]);

    // The Director is told, in the turn it takes for it.
    expect(adapter.sentMessages[0]!.text).toContain('A website for my bakery');
  });

  it('new work inside a project conversation creates nothing, and the Director is told to offer a new project', async () => {
    conversation(null);
    const bakery = seedProject(db, { name: 'Bakery site', path: path.join(tmpDir, 'bakery') });
    const bakeryConversation = conversation(bakery.id);

    await say(bakeryConversation.id, 'Also build me a website for my brother’s garage');
    await until(() => adapter.sentMessages.length === 1, 'the turn');

    expect(projects().map((p) => p.name)).toEqual(['Bakery site']);
    expect(getConversationById(db, bakeryConversation.id)!.director_state).toBeNull();
    expect(events('project.created')).toEqual([]);
    expect(adapter.sentMessages[0]!.text).toMatch(/offer .*new project/i);
  });

  it('creation is one transaction: a refused step leaves no project, no binding, no new conversation, no event', () => {
    // A.3 has no RESPONDING → INTAKE, so the last write in the transaction
    // throws after the project row and the binding were written.
    const company = conversation(null);
    db.prepare("UPDATE conversations SET director_state = 'RESPONDING' WHERE id = ?").run(
      company.id,
    );

    expect(() =>
      createProject(
        { db, activityLog },
        {
          companyId,
          name: 'Half made',
          conversation: { bind: company.id },
          actor: 'user',
          reason: 'test',
        },
      ),
    ).toThrow(/cannot go from RESPONDING to INTAKE/);

    expect(projects()).toEqual([]);
    expect(getConversationById(db, company.id)!.project_id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 1 });
    expect(events('project.created')).toEqual([]);
    expect(events('director.intake_started')).toEqual([]);
  });

  // ---- bureau_set_project_stage, over the real control channel, in a turn ----

  const setStage = (args: Record<string, unknown>) =>
    callBureauTool(adapter.startedContext!.controlChannel, 'bureau_set_project_stage', args);

  it("the tool's intake binds the company conversation, named from the user's own words", async () => {
    const company = conversation(null);
    insertConversationMessage(db, {
      conversation_id: company.id,
      project_id: null,
      author: 'user',
      kind: 'text',
      body: 'I need a way to track my plant watering',
      payload: null,
      checkpoint_id: null,
      status: 'complete',
    } as never);
    await inDirectorTurn(db, supervisorRegistry, company.id);

    const result = await setStage({ stage: 'intake', reason: 'The user describes new work.' });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(projects().map((p) => [p.name, p.stage])).toEqual([
      ['A way to track my plant watering', 'intake'],
    ]);
    expect(getConversationById(db, company.id)!.project_id).toBe(projects()[0]!.id);
    expect(events('project.created')[0]!.payload).toMatchObject({ conversationBound: true });
  });

  it("from inside a project's conversation, intake needs a name and starts a separate project with its own conversation", async () => {
    conversation(null);
    const bakery = seedProject(db, { name: 'Bakery site', path: path.join(tmpDir, 'bakery') });
    const bakeryConversation = conversation(bakery.id);
    await inDirectorTurn(db, supervisorRegistry, bakeryConversation.id);

    const unnamed = await setStage({ stage: 'intake', reason: 'The user accepted.' });
    expect(unnamed.ok).toBe(false);
    expect(JSON.stringify(unnamed)).toContain('give it a short name');

    const named = await setStage({
      stage: 'intake',
      reason: 'The user accepted.',
      name: 'Garage site',
    });
    expect(named.ok, JSON.stringify(named)).toBe(true);
    const garage = projects().find((p) => p.name === 'Garage site')!;
    const garageConversation = db
      .prepare('SELECT id, director_state FROM conversations WHERE project_id = ?')
      .get(garage.id) as { id: string; director_state: string };
    expect(garageConversation.id).not.toBe(bakeryConversation.id);
    expect(garageConversation.director_state).toBe('INTAKE');
    // The bakery's conversation is left exactly as it was.
    expect(getConversationById(db, bakeryConversation.id)).toMatchObject({
      project_id: bakery.id,
      director_state: null,
    });
  });

  it('a Director move goes with its A.3 partner; the user’s moves and unknown moves are refused and change nothing', async () => {
    const company = conversation(null);
    await inDirectorTurn(db, supervisorRegistry, company.id);
    expect((await setStage({ stage: 'intake', reason: 'new work', name: 'Menu app' })).ok).toBe(
      true,
    );
    const menu = projects()[0]!;
    await inDirectorTurn(db, supervisorRegistry, company.id);

    // intake → executing: §8 has no such move.
    const skipped = await setStage({ stage: 'executing', reason: 'hurry' });
    expect(JSON.stringify(skipped)).toContain("no move from 'intake' to 'executing'");

    // intake → brief: the Director's, with INTAKE → DRAFTING_BRIEF.
    const brief = await setStage({ stage: 'brief', reason: 'Enough is understood.' });
    expect(brief.ok, JSON.stringify(brief)).toBe(true);
    expect(projects()[0]!.stage).toBe('brief');
    expect(getConversationById(db, company.id)!.director_state).toBe('DRAFTING_BRIEF');
    expect(events('project.stage_changed').map((e) => e.payload)).toEqual([
      { from: 'intake', to: 'brief', reason: 'Enough is understood.' },
    ]);

    // brief → planning: the user's (invariant #2), refused.
    const planning = await setStage({ stage: 'planning', reason: 'Looks good to me.' });
    expect(planning.ok).toBe(false);
    expect(JSON.stringify(planning)).toContain("is the user's");
    expect(projects()[0]!.stage).toBe('brief');
    expect(menu.id).toBe(projects()[0]!.id);
  });

  it('a Director move whose A.3 partner is not valid from here is refused, and neither half is written', async () => {
    const company = conversation(null);
    await inDirectorTurn(db, supervisorRegistry, company.id);
    expect((await setStage({ stage: 'intake', reason: 'new work', name: 'Menu app' })).ok).toBe(
      true,
    );
    // The conversation's state is moved on behind the project's back.
    db.prepare("UPDATE conversations SET director_state = 'PLANNING' WHERE id = ?").run(company.id);
    await inDirectorTurn(db, supervisorRegistry, company.id);

    const result = await setStage({ stage: 'brief', reason: 'Enough is understood.' });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('your state in this conversation is PLANNING');
    expect(projects()[0]!.stage).toBe('intake');
    expect(events('project.stage_changed')).toEqual([]);
  });

  it('outside a project, a stage move has nothing to move', async () => {
    const company = conversation(null);
    await inDirectorTurn(db, supervisorRegistry, company.id);
    const result = await setStage({ stage: 'brief', reason: 'x' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('not about a project');
  });

  // ---- projects.create and projects.open ----

  it('projects.create pre-creates a project with a conversation of its own, and projects.open returns it', async () => {
    const workspace = path.join(tmpDir, 'existing-folder');
    const created = await dispatchIpcCall(
      'projects:create',
      getMethodSchema('projects', 'create'),
      projectsHandlers['create']!,
      ctx,
      true,
      { name: 'Existing app', path: workspace, kind: 'software' },
    );
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const project = (created as { data: { item: { id: string; stage: string; path: string } } })
      .data.item;
    expect(project).toMatchObject({ stage: 'intake', path: workspace });

    const opened = await dispatchIpcCall(
      'projects:open',
      getMethodSchema('projects', 'open'),
      projectsHandlers['open']!,
      ctx,
      true,
      { id: project.id },
    );
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    const conversationId = (opened as { data: { conversationId: string } }).data.conversationId;
    expect(getConversationById(db, conversationId)).toMatchObject({
      project_id: project.id,
      director_state: 'INTAKE',
    });
    // §5.1: and a company-level conversation exists beside it.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_id IS NULL').get(),
    ).toEqual({ n: 1 });
    expect(events('project.created')).toHaveLength(1);
    expect(events('director.intake_started')).toHaveLength(1);

    const unknown = await dispatchIpcCall(
      'projects:open',
      getMethodSchema('projects', 'open'),
      projectsHandlers['open']!,
      ctx,
      true,
      { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    );
    expect(unknown.ok).toBe(false);
  });

  it('projects.create refuses a relative path', async () => {
    const result = await dispatchIpcCall(
      'projects:create',
      getMethodSchema('projects', 'create'),
      projectsHandlers['create']!,
      ctx,
      true,
      { name: 'Somewhere', path: 'relative/folder', kind: 'software' },
    );
    expect(result.ok).toBe(false);
    expect(projects()).toEqual([]);
  });
});
