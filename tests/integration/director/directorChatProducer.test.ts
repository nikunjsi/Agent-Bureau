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
import { ChatStreamRegistry } from '../../../src/main/chat/chatStream';
import { SecretRegistry } from '../../../src/main/secrets/redactor';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import { getDbPaths } from '../../../src/main/db/paths';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';
import { callBureauTool, targetFromContext } from '../../helpers/bureauToolBridge';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * **The Director's producer: its prose, streamed into the chat.**
 *
 * `ChatStreamRegistry` and everything downstream of it (persistence, the two
 * stream events, the push, the "typing…" state, the aborted marker) were
 * built in M9, and nothing produced a stream. This drives the real chain:
 * `startDirector`, the Director's real Supervisor, and the chat read through
 * the real `chat.listMessages` handler. FakeAdapter scripts the engine's
 * output, and the turn's tool call goes over the real control channel
 * through S1-11a's bridge.
 *
 * What must hold: the prose, and only the prose. A tool call's arguments and
 * its result are the agent's working, not something said to the user, so
 * neither is ever written to the chat (CLAUDE.md: translate, don't show raw
 * engine output). `bureau_report` is how the Director posts something
 * structured, and it appears as its own card.
 */
const TOOL_ARGS_SENTINEL = 'TOOL-ARGS-SENTINEL';
const TOOL_RESULT_SENTINEL = 'TOOL-RESULT-SENTINEL';
const SECRET = 'sk-ant-api03-producer-must-redact-this';

describe("the Director's turn streams into the chat as prose only", () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let tokenRegistry: TokenRegistry;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let chatStreams: ChatStreamRegistry;
  let secrets: SecretRegistry;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-director-producer-'));
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
    server = new ControlChannelServer({ db, activityLog, tokenRegistry, supervisorRegistry });
    await server.start();
    chatStreams = new ChatStreamRegistry({ db, activityLog });
    secrets = new SecretRegistry();
    secrets.register([SECRET]);
  });

  afterEach(async () => {
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runningDirector() {
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' });
    const adapter = new FakeAdapter({
      keepOpen: true,
      capabilities: { mcpServers: true, sessionResume: true },
    });
    const result = await startDirector({
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
      chatSecretRegistry: secrets,
    });
    expect(result.status).toBe('started');
    const conversation = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
    return { adapter, conversationId: conversation.id };
  }

  async function listMessages(conversationId: string): Promise<ConversationMessage[]> {
    const ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, path.resolve('src/main/db/migrations')),
      baseDir: tmpDir,
    } as HandlerContext;
    const result = await dispatchIpcCall(
      'chat:listMessages',
      getMethodSchema('chat', 'listMessages'),
      chatHandlers['listMessages']!,
      ctx,
      true,
      { conversationId, beforeMessageId: null },
    );
    expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(true);
    return (result as { ok: true; data: { items: ConversationMessage[] } }).data.items;
  }

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function eventTypes(): string[] {
    return readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { type: string }).type);
  }

  it('text, a real tool call, more text: the chat holds the prose, and the report is its own card', async () => {
    const { adapter, conversationId } = await runningDirector();
    const streamed = (): ConversationMessage | undefined =>
      (
        db
          .prepare(
            "SELECT * FROM conversation_messages WHERE kind = 'text' AND author = 'director'",
          )
          .all() as ConversationMessage[]
      )[0];

    adapter.pushEvent({ t: 'turn.started', turnIndex: 0 });
    adapter.pushEvent({ t: 'text.delta', text: 'Let me check where things stand.' });
    await until(() => streamed() !== undefined, 'the stream to begin');
    // The "typing…" indicator is the row's own status (MessageRow.tsx).
    expect(streamed()!.status).toBe('streaming');

    adapter.pushEvent({
      t: 'tool.requested',
      callId: 'call-1',
      tool: 'mcp__bureau__bureau_report',
      rawTool: 'mcp__bureau__bureau_report',
      args: { note: TOOL_ARGS_SENTINEL },
      preview: TOOL_ARGS_SENTINEL,
    });
    const reply = await callBureauTool(
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
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    adapter.pushEvent({
      t: 'tool.completed',
      callId: 'call-1',
      ok: true,
      excerpt: TOOL_RESULT_SENTINEL,
      ms: 5,
    });
    adapter.pushEvent({
      t: 'text.delta',
      text: `I posted the report. Your key ${SECRET} is safe.`,
    });
    adapter.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    await until(() => streamed()?.status === 'complete', 'the stream to complete');

    const messages = await listMessages(conversationId);
    const prose = messages.filter((m) => m.kind === 'text');
    expect(prose).toHaveLength(1);
    expect(prose[0]!.author).toBe('director');
    expect(prose[0]!.body).toBe(
      'Let me check where things stand.\n\nI posted the report. Your key «redacted:secret» is safe.',
    );
    const everything = JSON.stringify(messages);
    expect(everything).not.toContain(TOOL_ARGS_SENTINEL);
    expect(everything).not.toContain(TOOL_RESULT_SENTINEL);
    expect(everything).not.toContain(SECRET);
    expect(messages.filter((m) => m.kind === 'report').map((m) => m.body)).toEqual([
      'Two tasks are done and one is blocked.',
    ]);

    const types = eventTypes();
    expect(types.filter((t) => t === 'chat.stream_started')).toHaveLength(1);
    expect(types.filter((t) => t === 'chat.stream_completed')).toHaveLength(1);
  });

  it('a turn that only calls tools writes no message, and an engine error marks the reply interrupted', async () => {
    const { adapter } = await runningDirector();
    const rows = () =>
      db
        .prepare("SELECT * FROM conversation_messages WHERE kind = 'text'")
        .all() as ConversationMessage[];

    adapter.pushEvent({ t: 'turn.started', turnIndex: 0 });
    adapter.pushEvent({
      t: 'tool.requested',
      callId: 'c',
      tool: 'Read',
      rawTool: 'Read',
      args: {},
      preview: '',
    });
    adapter.pushEvent({ t: 'tool.completed', callId: 'c', ok: true, excerpt: 'x', ms: 1 });
    adapter.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    adapter.pushEvent({ t: 'turn.started', turnIndex: 1 });
    adapter.pushEvent({ t: 'text.delta', text: 'Half a thou' });
    adapter.pushEvent({ t: 'finished', reason: 'error', summary: 'the engine stopped' });
    await until(() => rows()[0]?.status === 'aborted', 'the reply to be marked interrupted');

    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.body).toBe('Half a thou');
  });
});
