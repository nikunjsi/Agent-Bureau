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
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { setSetting } from '../../../src/main/db/repositories/settings';
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
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * **Compaction** (M11 row S1-18, §8.0.1, risk #16). After
 * `director.compactAfterTurns` Director turns, the next turn waits while a
 * compaction turn writes a structured summary to `conversations.summary`.
 * Then a FRESH engine session begins, seeded with that summary plus the
 * S1-17 assembly; the new session's id is recorded; one
 * `director.context_compacted` is emitted; and the chat gets one plain line.
 * The compaction turn's own words never reach the chat.
 *
 * Real chain: `chat.send`, the router, the trigger queue, `startDirector`'s
 * Supervisor with its chat producer, FakeAdapter emitting real-shaped turns.
 */
const SUMMARY = 'SUMMARY: the user wants a bakery website with online cake orders.';

describe('the Director compacts its context and starts a fresh, seeded session', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let triggers: DirectorTriggers;
  let ctx: HandlerContext;
  let chatStreams: ChatStreamRegistry;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-compaction-'));
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
    setSetting(db, 'director.compactAfterTurns', 2);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    companyId = seedCompany(db, path.join(tmpDir, 'home')).id;
    installShippedPack({ db, activityLog, baseDir, packKey: 'operations' });
    supervisorRegistry = new SupervisorRegistry();
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry: new TokenRegistry(),
      supervisorRegistry,
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

  it('after N turns: summary written, fresh seeded session, one event, one plain line', async () => {
    const director = hireEmployee({
      db,
      activityLog,
      companyId,
      baseDir,
      roleKey: 'operations:director',
    }).employee;
    const adapter = new FakeAdapter({
      keepOpen: true,
      capabilities: { mcpServers: true, sessionResume: true },
    });
    const started = await startDirector({
      db,
      activityLog,
      tokenRegistry: new TokenRegistry(),
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
    const conversationId = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    }).id;

    const say = async (body: string) => {
      const result = await dispatchIpcCall(
        'chat:send',
        getMethodSchema('chat', 'send'),
        chatHandlers['send']!,
        ctx,
        true,
        { conversationId, body },
      );
      expect(result.ok).toBe(true);
      await routeOnce(
        { db, activityLog, supervisorRegistry, appStartedAtMs: 0, directorTriggers: triggers },
        { nowMs: Date.now() },
      );
    };
    /** One real-shaped structured turn: the engine's session, prose, the end. */
    const turn = (sessionId: string, prose: string) => {
      adapter.pushEvent({ t: 'session.started', sessionId, engineVersion: 'x', model: 'm' });
      adapter.pushEvent({ t: 'turn.started', turnIndex: 0 });
      adapter.pushEvent({ t: 'text.delta', text: prose });
      adapter.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
      adapter.pushEvent({ t: 'finished', reason: 'completed', summary: null });
    };

    await say('I want a website for my bakery.');
    await until(() => adapter.sentMessages.length === 1, 'turn 1');
    turn('sess-old', 'Tell me more.');
    await say('Families order cakes online.');
    await until(() => adapter.sentMessages.length === 2, 'turn 2');
    turn('sess-old', 'Got it.');
    const turnsEnded = () =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE type = 'employee.idle' AND json_extract(payload, '$.reason') = 'turn_completed'",
          )
          .get() as { n: number }
      ).n;
    await until(() => turnsEnded() === 2, 'both turns to end');
    expect(getEmployeeById(db, director.id)?.session_id).toBe('sess-old');

    // The third message finds two turns since the last compaction.
    // The first turn already switched to this conversation's own session
    // (M11 S2-1a), which had none; compaction's reset is the one after it.
    const resetsBeforeCompaction = adapter.sessionResets;
    await say('Also a gallery of past cakes.');
    await until(() => adapter.sentMessages.length === 3, 'the compaction turn');
    expect(adapter.sentMessages[2]!.text).toContain('structured summary');
    expect(triggers.isCompacting()).toBe(true);
    turn('sess-old', SUMMARY);

    // Compaction done: the waiting user turn goes out on a fresh session.
    await until(() => adapter.sentMessages.length === 4, 'the user turn after compaction');
    expect(adapter.sentMessages[3]!.text).toContain('Also a gallery of past cakes.');
    expect(adapter.sessionResets).toBe(resetsBeforeCompaction + 1);
    expect(getEmployeeById(db, director.id)?.session_id).toBeNull();
    expect(getConversationById(db, conversationId)?.summary).toBe(SUMMARY);

    // Seeded: the fresh session's context carries the summary.
    const context = readFileSync(
      path.join(getEmployeeStateDir(baseDir, director.id), DIRECTOR_CONTEXT_FILE),
      'utf8',
    );
    expect(context).toContain(SUMMARY);

    // One event, one plain line, and the summary itself never in the chat.
    const compacted = db
      .prepare("SELECT payload FROM events WHERE type = 'director.context_compacted'")
      .all() as Array<{ payload: string }>;
    expect(compacted).toHaveLength(1);
    const chat = db
      .prepare('SELECT author, body FROM conversation_messages WHERE conversation_id = ?')
      .all(conversationId) as Array<{ author: string; body: string }>;
    expect(chat.filter((m) => m.author === 'system')).toHaveLength(1);
    expect(JSON.stringify(chat)).not.toContain('SUMMARY:');

    // The fresh session's id replaces the old one on the conversation.
    turn('sess-new', 'A gallery, noted.');
    await until(
      () => getConversationById(db, conversationId)?.director_session_id === 'sess-new',
      'the new session to be recorded',
    );
  });
});
