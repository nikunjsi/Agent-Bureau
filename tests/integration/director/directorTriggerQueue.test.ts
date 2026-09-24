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
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { routeOnce } from '../../../src/main/messages/router';
import { getDirectorState } from '../../../src/main/director/directorState';
import { getDbPaths } from '../../../src/main/db/paths';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import { checkpointsHandlers } from '../../../src/main/ipc/handlers/checkpoints';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * The trigger queue in the running chain (M11 row S1-15): real producers
 * (`chat.send`, `checkpoints.answer`), the real message router, the real
 * Director Supervisor from `startDirector`, and FakeAdapter emitting what a
 * real structured `claude -p` turn emits — `turn.started`, then
 * `turn.completed` and `finished` when the process exits. No `idle` event:
 * the real adapter emits none, which is why the Supervisor itself has to
 * land the Director on `idle` (at start, and when a task-less turn ends).
 * The queue's rules are proven on a fake clock in `triggerQueue.test.ts`;
 * this proves the app is wired to them.
 */
describe("the Director's turns come from the trigger queue", () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let triggers: DirectorTriggers;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-director-triggers-'));
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
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry: new TokenRegistry(),
      supervisorRegistry,
    });
    await server.start();
    triggers = createDirectorTriggers({ db, activityLog, supervisorRegistry });
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

  async function runningDirector() {
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
    const result = await startDirector({
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
      directorTriggers: triggers,
    });
    expect(result.status).toBe('started');
    const conversationId = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    }).id;
    return { adapter, directorId: director.id, conversationId };
  }

  async function send(conversationId: string, body: string): Promise<void> {
    const result = await dispatchIpcCall(
      'chat:send',
      getMethodSchema('chat', 'send'),
      chatHandlers['send']!,
      ctx,
      true,
      { conversationId, body },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
  }

  const route = () =>
    routeOnce(
      { db, activityLog, supervisorRegistry, appStartedAtMs: 0, directorTriggers: triggers },
      { nowMs: Date.now() },
    );

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const undelivered = () =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE to_addr = 'director' AND delivered_at IS NULL",
        )
        .get() as { n: number }
    ).n;

  it('a started Director is idle; a user message becomes a turn; messages sent mid-turn become the next one', async () => {
    const { adapter, directorId, conversationId } = await runningDirector();
    const director = supervisorRegistry.get(directorId)!;
    expect(director.currentState, 'a structured Director between turns is at a prompt').toBe(
      'idle',
    );

    await send(conversationId, 'Hello there');
    const first = await route();
    expect(first.offeredToDirector).toHaveLength(1);
    await until(() => adapter.sentMessages.length === 1, 'the first turn');
    expect(adapter.sentMessages[0]!.text).toContain('The user wrote:\n\nHello there');
    expect(undelivered()).toBe(0);

    // The turn is running. Two more messages arrive.
    adapter.pushEvent({ t: 'turn.started', turnIndex: 0 });
    await until(() => director.currentState === 'working', 'the turn to start');
    await send(conversationId, 'Also this');
    await send(conversationId, 'And that');
    await route();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(adapter.sentMessages, 'nothing is sent mid-generation').toHaveLength(1);
    expect(undelivered()).toBe(2);

    // The turn ends as a real structured turn does, with no `idle` event.
    adapter.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    adapter.pushEvent({ t: 'finished', reason: 'completed', summary: null });
    await until(() => adapter.sentMessages.length === 2, 'the next turn');
    expect(director.currentState).not.toBe('blocked');
    const second = adapter.sentMessages[1]!.text;
    expect(second).toContain('Also this');
    expect(second).toContain('And that');
    expect(undelivered()).toBe(0);
  });

  // M11 row S1-16: each user-message turn is classified by the one
  // classifier, and new work moves the conversation into intake (A.3).
  it('a user message describing new work starts intake before the turn is sent; chat does not', async () => {
    const { adapter, conversationId } = await runningDirector();
    const state = () => getDirectorState(db, conversationId).state;

    await send(conversationId, 'hi, how are you');
    await route();
    await until(() => adapter.sentMessages.length === 1, 'the chat turn');
    expect(state()).toBe('IDLE');
    expect(adapter.sentMessages[0]!.text).toContain('Bureau read this message as: conversation');
    adapter.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    adapter.pushEvent({ t: 'finished', reason: 'completed', summary: null });

    await send(conversationId, 'Build me a website for my bakery');
    await route();
    await until(() => adapter.sentMessages.length === 2, 'the new-work turn');
    expect(state()).toBe('INTAKE');
    expect(adapter.sentMessages[1]!.text).toContain('Bureau read this message as: new work');
    const intake = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'director.intake_started'")
      .get() as { n: number };
    expect(intake.n).toBe(1);
  });

  it('an answered blocking checkpoint wakes the Director at once', async () => {
    const { adapter } = await runningDirector();
    const checkpoint = insertCheckpoint(db, activityLog, {
      project_id: null,
      task_id: null,
      employee_id: null,
      type: 'decision',
      urgency: 'blocking',
      title: 'Skip the unreadable rows?',
      context: 'Three rows cannot be read.',
      options: [
        { id: 'skip', label: 'Skip them', consequence: 'The import finishes without them.' },
        {
          id: 'stop',
          label: 'Stop',
          consequence: 'Nothing is imported until you decide.',
          reversible: true,
        },
      ],
      default_action: 'stop',
    });
    const result = await dispatchIpcCall(
      'checkpoints:answer',
      getMethodSchema('checkpoints', 'answer'),
      checkpointsHandlers['answer']!,
      ctx,
      true,
      { id: checkpoint.id, optionId: 'skip' },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await until(() => adapter.sentMessages.length === 1, 'the checkpoint turn');
    expect(adapter.sentMessages[0]!.text).toContain('Skip the unreadable rows?');
  });
});
