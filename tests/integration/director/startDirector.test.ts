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
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { runShutdownSequence } from '../../../src/main/shutdownSequence';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import {
  DIRECTOR_ENGINE_UNSUITABLE_MESSAGE,
  reportDirectorStart,
  startDirector,
} from '../../../src/main/director/startDirector';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * The first production Supervisor is the Director's (M11 row S1-8; pre-M11
 * §M11 item 2 and §F S-1; `NEXT-VERSION` §H.6). Before this, nothing in
 * `src/` called `spawnSupervisedEmployee`: every Supervisor in the repo was
 * built by a test. These drive `startDirector` itself — the function
 * `main()` calls — with only the engine swapped, at the adapter factory,
 * for a FakeAdapter.
 */
describe('startDirector: the Director gets a real, registered, stoppable Supervisor', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let tokenRegistry: TokenRegistry;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let port: number;
  let dbPath: string;
  /** The shutdown case closes the database, the log and the server itself. */
  let shutDown: boolean;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-start-director-'));
    baseDir = path.join(tmpDir, 'userData');
    dbPath = path.join(tmpDir, 'bureau.db');
    shutDown = false;
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
    port = await server.start();
  });

  afterEach(async () => {
    if (!shutDown) {
      for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
      await server.stop();
      activityLog.close();
      db.close();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function hireDirector() {
    return hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' })
      .employee;
  }

  function start(adapter: FakeAdapter) {
    return startDirector({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      controlChannelPort: port,
      baseDir,
      secretBroker: noopSecretBroker,
      // The FakeAdapter spawns nothing, so there is nothing to contain.
      containProcess: () => {},
      createAdapter: () => adapter,
      resolveToolsScriptPath: resolveBureauToolsScriptPathForTests,
    });
  }

  const suitableEngine = () =>
    new FakeAdapter({ keepOpen: true, capabilities: { mcpServers: true, sessionResume: true } });

  it('registers a Supervisor for the hired Director, with no task and no worktree', async () => {
    const director = hireDirector();
    const adapter = suitableEngine();

    const result = await start(adapter);

    expect(result.status).toBe('started');
    const entry = supervisorRegistry.get(director.id);
    expect(entry).toBeDefined();
    expect(adapter.startedContext?.employee.id).toBe(director.id);
    expect(adapter.startedContext?.task).toBeNull();
    expect(adapter.startedContext?.worktreePath).toBe('');
    // What the policy evaluator reads for every tool call (N-3): the LIVE
    // capabilities of the registered Supervisor, not "unknown".
    expect(entry?.getCapabilities()?.mcpServers).toBe(true);
  });

  it('is stopped by the shutdown sequence, and the row says so', async () => {
    const director = hireDirector();
    await start(suitableEngine());

    shutDown = true;
    await runShutdownSequence({
      supervisors: supervisorRegistry,
      controlChannelServer: server,
      resumeTick: { stop: () => {} },
      checkpointTick: { stop: () => {} },
      messageRouter: { stop: () => {} },
      stopLiveState: () => {},
      chatStreams: { abortAll: () => 0 },
      activityLog,
      db,
    });

    expect(supervisorRegistry.all()).toHaveLength(0);
    const reopened = openConnection(dbPath);
    try {
      expect(getEmployeeById(reopened, director.id)?.status).toBe('off');
    } finally {
      reopened.close();
    }
  });

  it('does nothing when no Director is hired yet', async () => {
    const result = await start(suitableEngine());

    expect(result.status).toBe('no_director');
    expect(supervisorRegistry.all()).toHaveLength(0);
  });

  it('says plainly that the engine cannot host the Director, and leaves nothing running (§8.0)', async () => {
    hireDirector();

    // FakeAdapter's own default: no MCP support.
    const result = await start(new FakeAdapter({ keepOpen: true }));

    expect(result.status).toBe('engine_unsuitable');
    if (result.status !== 'engine_unsuitable') return;
    expect(result.message).toMatch(/Director/);
    expect(result.message).not.toMatch(/mcpServers|sessionResume/);
    expect(supervisorRegistry.all()).toHaveLength(0);
  });

  it('the unsuitable-engine message reaches the chat as one plain system message', async () => {
    hireDirector();
    const conversation = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
    const result = await start(new FakeAdapter({ keepOpen: true }));

    reportDirectorStart({ db, activityLog }, result);

    const rows = db
      .prepare('SELECT author, kind, body FROM conversation_messages WHERE conversation_id = ?')
      .all(conversation.id);
    expect(rows).toEqual([
      { author: 'system', kind: 'error', body: DIRECTOR_ENGINE_UNSUITABLE_MESSAGE },
    ]);
  });

  it('a second call while the Director runs starts nothing new', async () => {
    const director = hireDirector();
    await start(suitableEngine());
    const first = supervisorRegistry.get(director.id);

    const again = await start(suitableEngine());

    expect(again.status).toBe('already_running');
    expect(supervisorRegistry.get(director.id)).toBe(first);
  });
});
