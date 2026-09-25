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
import { writeMemory } from '../../../src/main/memory/memoryStore';
import { ChatStreamRegistry } from '../../../src/main/chat/chatStream';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { routeOnce } from '../../../src/main/messages/router';
import { getDbPaths, getEmployeeStateDir } from '../../../src/main/db/paths';
import { DIRECTOR_CONTEXT_FILE } from '../../../src/shared/engine/directorContextFile';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { Conversation } from '../../../src/shared/models/conversation';
import { seedBrief, seedPhase, seedPlan, seedProject } from '../../helpers/dbFixtures';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S2-1a, Nikunj's isolation requirement (2026-09-25): **a message in
 * one project's conversation is handled entirely inside that project.**
 *
 * Two deliberately similar projects — two restaurant websites for the same
 * owner — each with its own conversation, brief, plan, memory and engine
 * session. A user message in one of them must be assembled from that
 * project's rows only, run on that conversation's engine session, be
 * answered (prose and cards) in that conversation, and leave the other's
 * rows untouched. Before this row the Director's conversation was simply
 * "the most recently created one", and it ran one engine session for all
 * of them, so the second restaurant's transcript would have been resumed
 * into the first's turn.
 *
 * Real chain: `chat.send`, the router, the trigger queue, `startDirector`'s
 * Supervisor with its chat producer, the real control channel for the
 * card, FakeAdapter emitting real-shaped turns.
 */
interface Restaurant {
  readonly projectId: string;
  readonly conversation: Conversation;
  readonly brief: string;
  readonly phase: string;
  readonly memory: string;
  readonly session: string;
}

describe("a project's conversation is answered from that project alone", () => {
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
  let chatStreams: ChatStreamRegistry;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-isolation-'));
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
    chatStreams = new ChatStreamRegistry({ db, activityLog });
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

  function conversation(projectId: string | null, session: string | null): Conversation {
    return insertConversation(db, {
      company_id: companyId,
      project_id: projectId,
      title: projectId === null ? 'Company' : 'Project',
      director_session_id: session,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
  }

  /** One restaurant: a project with its own brief, plan, memory and session. */
  function restaurant(name: string, cuisine: string, session: string): Restaurant {
    const project = seedProject(db, { name, path: path.join(tmpDir, name) });
    const brief = `BRIEF-${cuisine}: a site for ${name} where diners book a table.`;
    const briefRow = seedBrief(db, {
      project_id: project.id,
      markdown: brief,
      content: { summary: brief },
    } as never);
    const plan = seedPlan(db, { project_id: project.id, brief_id: briefRow.id });
    const phase = `PHASE-${cuisine}`;
    seedPhase(db, { plan_id: plan.id, name: phase, goal: `Show the ${cuisine} menu.` });
    const memory = `MEMORY-${cuisine}: the owner wants the ${cuisine} menu first.`;
    writeMemory(db, {
      scope: 'project',
      scopeRef: project.id,
      fileName: 'decisions.md',
      baseDir,
      title: 'Decisions',
      body: memory,
      source: 'observed',
      pinned: true,
    } as never);
    return {
      projectId: project.id,
      conversation: conversation(project.id, session),
      brief,
      phase,
      memory,
      session,
    };
  }

  it('assembles, resumes, answers and writes in the one conversation the message came from', async () => {
    const director = hireEmployee({
      db,
      activityLog,
      companyId,
      baseDir,
      roleKey: 'operations:director',
    }).employee;
    // The company conversation is created first, so every project's
    // conversation is newer than it — "the most recent" is never the answer.
    conversation(null, null);
    const trattoria = restaurant('Luigi Trattoria', 'TRATTORIA', 'session-trattoria');
    const pizzeria = restaurant('Luigi Pizzeria', 'PIZZERIA', 'session-pizzeria');

    const adapter = new FakeAdapter({
      keepOpen: true,
      capabilities: { mcpServers: true, sessionResume: true },
      resumeResults: { 'session-trattoria': true, 'session-pizzeria': true },
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
      chatStreams,
      directorTriggers: triggers,
    });
    expect(started.status).toBe('started');

    const say = async (conversationId: string, body: string) => {
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
    };
    const contextText = () =>
      readFileSync(
        path.join(getEmployeeStateDir(baseDir, director.id), DIRECTOR_CONTEXT_FILE),
        'utf8',
      );
    const rowsOf = (id: string) =>
      db
        .prepare('SELECT author, kind, body FROM conversation_messages WHERE conversation_id = ?')
        .all(id) as { author: string; kind: string; body: string }[];
    const untouched = (r: Restaurant) => {
      const now = getConversationById(db, r.conversation.id)!;
      expect(now.director_session_id).toBe(r.session);
      expect(now.director_state).toBe(r.conversation.director_state);
      expect(now.updated_at).toBe(r.conversation.updated_at);
      expect(rowsOf(r.conversation.id)).toEqual([]);
    };

    // ---- a message in the trattoria's conversation ----
    await say(trattoria.conversation.id, 'How is the menu page coming along?');
    await until(() => adapter.sentMessages.length === 1, 'the trattoria turn');

    const trattoriaContext = contextText();
    console.log('resumed for the trattoria turn:', adapter.resumedSessionIds.at(-1));
    for (const own of [trattoria.brief, trattoria.phase, trattoria.memory]) {
      expect(trattoriaContext).toContain(own);
    }
    for (const other of [pizzeria.brief, pizzeria.phase, pizzeria.memory]) {
      expect(trattoriaContext).not.toContain(other);
    }
    expect(adapter.resumedSessionIds.at(-1)).toBe('session-trattoria');

    // Mid-turn, the Director's card goes where the turn is.
    const card = await callBureauTool(adapter.startedContext!.controlChannel, 'bureau_report', {
      kind: 'report',
      body: 'The trattoria menu page is half done.',
      payload: { whatHappened: 'Menu page started.' },
    });
    expect(card.ok, JSON.stringify(card)).toBe(true);
    adapter.pushEvent({
      t: 'session.started',
      sessionId: 'session-trattoria-2',
      engineVersion: 'x',
      model: 'm',
    });
    adapter.pushEvent({ t: 'turn.started', turnIndex: 0 });
    adapter.pushEvent({ t: 'text.delta', text: 'The trattoria menu is next.' });
    adapter.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    adapter.pushEvent({ t: 'finished', reason: 'completed', summary: null });
    await until(
      () =>
        rowsOf(trattoria.conversation.id).some((r) => r.author === 'director' && r.kind === 'text'),
      "the trattoria's reply",
    );

    expect(rowsOf(trattoria.conversation.id).map((r) => [r.author, r.kind])).toEqual([
      ['user', 'text'],
      ['director', 'report'],
      ['director', 'text'],
    ]);
    // The session the engine reported is that conversation's, and only its.
    await until(
      () =>
        getConversationById(db, trattoria.conversation.id)?.director_session_id ===
        'session-trattoria-2',
      "the trattoria's new session id",
    );
    untouched(pizzeria);

    // ---- and back the other way: the pizzeria's own session and rows ----
    await say(pizzeria.conversation.id, 'How is the menu page coming along?');
    await until(() => adapter.sentMessages.length === 2, 'the pizzeria turn');
    const pizzeriaContext = contextText();
    expect(pizzeriaContext).toContain(pizzeria.brief);
    expect(pizzeriaContext).not.toContain(trattoria.brief);
    expect(pizzeriaContext).not.toContain(trattoria.memory);
    expect(adapter.resumedSessionIds.at(-1)).toBe('session-pizzeria');
  });
});
