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
import { insertUsage } from '../../../src/main/db/repositories/usage';
import { setSetting } from '../../../src/main/db/repositories/settings';
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
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * **The budget reserve, and the no-model fallback** (M11 row S1-19, §8.0).
 * The Director may draw to the FULL budget; employees stop at budget minus
 * the reserve. When even the Director's full budget is spent, no Director
 * turn may be spawned — a turn is money — and the user is told in one
 * plain `system` `error` message with the `raise_budget` remedy, written by
 * plain code with no model call. The message waits, undelivered, and goes
 * out once the budget is raised.
 */
describe('with the reserve gone, the Director spends nothing and says so without a model', () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-director-reserve-'));
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

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('no turn at exhaustion, one plain raise_budget message, and the turn goes once the budget is raised', async () => {
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' });
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

    // Today's whole budget, reserve included, is spent: $1 of $1.
    setSetting(db, 'budgets.dailyUsd', 1);
    insertUsage(db, { engine: 'claude-code', cost_usd_micros: 1_000_000, source: 'turn' });

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
    const notices = () =>
      db
        .prepare(
          "SELECT author, kind, body, payload FROM conversation_messages WHERE kind = 'error'",
        )
        .all() as Array<{ author: string; kind: string; body: string; payload: string }>;

    await say('Can you start on the menu page?');
    await say('Hello?');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(adapter.sentMessages, 'a Director turn was spawned with the reserve gone').toHaveLength(
      0,
    );
    expect(notices()).toHaveLength(1);
    const notice = notices()[0]!;
    expect(notice.author).toBe('system');
    expect(JSON.parse(notice.payload)).toMatchObject({
      code: 'director_budget_exhausted',
      remedy: { kind: 'raise_budget' },
    });
    expect(notice.body).not.toMatch(/\$0\.00/);
    // Nothing billed for saying so.
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n).toBe(1);

    // Raised: the waiting messages go out as one turn.
    setSetting(db, 'budgets.dailyUsd', 10);
    triggers.queue.pump();
    await until(() => adapter.sentMessages.length === 1, 'the turn after raising the budget');
    expect(adapter.sentMessages[0]!.text).toContain('Can you start on the menu page?');
    expect(adapter.sentMessages[0]!.text).toContain('Hello?');
  });
});
