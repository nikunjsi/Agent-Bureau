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
import type { ChatBroadcaster } from '../../../src/main/chat/chatBroadcaster';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';
import { callBureauTool, targetFromContext } from '../../helpers/bureauToolBridge';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S2-0, invariant #1: **a card a tool handler posts reaches the open
 * window when it is posted**, not at the window's next re-hydrate.
 *
 * The Director's prose streams through `main()`'s `ChatStreamRegistry` and
 * was always pushed. Its cards — `bureau_report` today, the brief, the
 * plan and intake's questions next — are written by tool handlers, and a
 * handler's context had no broadcaster, so the row landed and the window
 * never heard. An approval card the user cannot see stalls the whole
 * conversation.
 *
 * The listener stands where the renderer's chat store does: on the one
 * `ChatBroadcaster` `main()` builds and hands the control channel. Nothing
 * here calls `chat.listMessages`, so a message it sees was pushed.
 */
describe('a Director card reaches the open window over the real control channel', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let tokenRegistry: TokenRegistry;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let pushed: ConversationMessage[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-card-push-'));
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
    tokenRegistry = new TokenRegistry();
    supervisorRegistry = new SupervisorRegistry();
    pushed = [];
    const window: ChatBroadcaster = { messageChanged: (message) => pushed.push(message) };
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      baseDir,
      chatBroadcaster: window,
    });
  });

  afterEach(async () => {
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bureau_report pushes its card to the window as it is written', async () => {
    const port = await server.start();
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' });
    const adapter = new FakeAdapter({
      keepOpen: true,
      capabilities: { mcpServers: true, sessionResume: true },
    });
    const started = await startDirector({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      controlChannelPort: port,
      baseDir,
      secretBroker: noopSecretBroker,
      containProcess: () => {},
      createAdapter: () => adapter,
      resolveToolsScriptPath: resolveBureauToolsScriptPathForTests,
    });
    expect(started.status).toBe('started');
    const conversation = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });

    const result = await callBureauTool(
      targetFromContext(adapter.startedContext!),
      'bureau_report',
      {
        kind: 'report',
        body: 'Two tasks are done and one is blocked.',
        payload: {
          whatHappened: 'Two tasks are done.',
          whatChanged: ['api'],
          whatIsNext: 'review',
        },
      },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const messageId = (result['data'] as { messageId: string }).messageId;
    expect(
      pushed.map((m) => ({ id: m.id, conversation: m.conversation_id, kind: m.kind })),
    ).toEqual([{ id: messageId, conversation: conversation.id, kind: 'report' }]);
  });
});
