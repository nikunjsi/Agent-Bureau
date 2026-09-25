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
import { memoryAbsolutePath } from '../../../src/main/memory/memoryStore';
import { decisionLogLocation } from '../../../src/main/checkpoints/decisionLog';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S2-2b, §8.1: **"If the user says 'you decide', the Director decides,
 * states the decision and its consequence explicitly, and moves on. It does
 * not re-ask."** Scripted end to end: the Director asks a batch in intake,
 * the user answers "You decide.", and in the turn that answer starts the
 * Director records the decision with `bureau_record_decision`. The decision
 * log then holds it, and the question cannot be asked again (invariant #9).
 *
 * Real chain: `chat.send`, the router, the trigger queue, the real Director
 * on FakeAdapter (scripted output), the real control channel for both tools.
 */
describe('"you decide" leads to a recorded decision the Director cannot re-ask', () => {
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
  let directorId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-you-decide-'));
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
    directorId = hireEmployee({
      db,
      activityLog,
      companyId,
      baseDir,
      roleKey: 'operations:director',
    }).employee.id;
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

  /** The start of a scripted turn, as a real engine opens one: until it, the
   *  Director is idle and the queue may send the next turn. */
  const startTurn = () => adapter.pushEvent({ t: 'turn.started', turnIndex: 0 });

  /** The end of a scripted turn. */
  const endTurn = () => {
    adapter.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    adapter.pushEvent({ t: 'finished', reason: 'completed', summary: null });
  };

  const tool = (name: string, args: Record<string, unknown>) =>
    callBureauTool(adapter.startedContext!.controlChannel, name, args);

  const bookingQuestion = {
    id: 'booking',
    text: 'How should diners book a table?',
    options: [
      { id: 'phone', label: 'By phone' },
      { id: 'online', label: 'Online' },
    ],
    recommendation: { optionId: 'phone', why: 'Nothing to build, and it is how you work today.' },
  };
  const menuQuestion = {
    id: 'menu',
    text: 'Should the menu be on the site?',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
    recommendation: { optionId: 'yes', why: 'It is what most visitors look for first.' },
  };

  it('asks, hears "you decide", records the decision, and is then refused the same question', async () => {
    const company = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Test Co',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
    await say(company.id, 'Build me a website for my trattoria');
    await until(() => adapter.sentMessages.length === 1, 'the first turn');
    startTurn();
    const project = db.prepare('SELECT id FROM projects').get() as { id: string };

    // Turn 1: the Director asks its batch, then ends the turn.
    const asked = await tool('bureau_report', {
      kind: 'question',
      body: 'Two questions before I write the brief.',
      payload: { questions: [bookingQuestion, menuQuestion] },
    });
    expect(asked.ok, JSON.stringify(asked)).toBe(true);
    endTurn();

    // The user hands the decision back.
    await say(company.id, 'You decide.');
    await until(() => adapter.sentMessages.length === 2, 'the turn "you decide" starts');
    startTurn();
    expect(adapter.sentMessages[1]!.text).toContain('You decide.');
    // The prompt that turn runs under says what to do with it.
    const context = readFileSync(
      path.join(getEmployeeStateDir(baseDir, directorId), DIRECTOR_CONTEXT_FILE),
      'utf8',
    );
    expect(context).toContain('record it with bureau_record_decision');

    // Turn 2, scripted: decide, record, move on.
    const recorded = await tool('bureau_record_decision', {
      title: 'How should diners book a table?',
      asked_because: 'The site could take bookings, or leave them to the phone.',
      options: ['By phone', 'Online'],
      chosen: 'By phone — the user asked me to decide, and it is how the trattoria works today.',
      consequence: 'No booking system to build or maintain; the site shows the phone number.',
    });
    expect(recorded.ok, JSON.stringify(recorded)).toBe(true);
    endTurn();

    const log = readFileSync(memoryAbsolutePath(baseDir, decisionLogLocation(project.id)), 'utf8');
    expect(log).toMatch(/## \d{4}-\d{2}-\d{2} — How should diners book a table\?/);
    expect(log).toContain('**Chosen:** By phone');
    expect(log).toContain('**Consequence:** No booking system to build or maintain');
    const applied = readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"memory.write_applied"'));
    expect(applied).toHaveLength(1);

    // Invariant #9: the same question is now refused, with the answer.
    await say(company.id, 'One more thing: the logo is attached.');
    await until(() => adapter.sentMessages.length === 3, 'a later turn');
    startTurn();
    const again = await tool('bureau_report', {
      kind: 'question',
      body: 'Two more questions.',
      payload: {
        questions: [
          bookingQuestion,
          { ...menuQuestion, id: 'photos', text: 'Do you have photos of the dishes?' },
        ],
      },
    });
    expect(again.ok).toBe(false);
    expect(JSON.stringify(again)).toContain('By phone');
  });

  it('outside a project there is no decision log to write to', async () => {
    const company = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Test Co',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
    await say(company.id, 'Hello there');
    await until(() => adapter.sentMessages.length === 1, 'the turn');
    startTurn();
    const result = await tool('bureau_record_decision', {
      title: 'Anything',
      asked_because: 'x',
      chosen: 'y',
      consequence: 'z',
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('not about a project');
  });
});
