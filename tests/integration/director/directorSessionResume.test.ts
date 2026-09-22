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
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * §8.0: the Director is "one persistent session per company, resumed by
 * `session_id` across restarts" (M11 row S1-11). `employees.session_id` had
 * been written only at insert, so every restart began a new conversation
 * with an engine that remembered nothing — the exact failure §26 item 1
 * names ("forgets everything between messages; re-asks answered
 * questions").
 *
 * One writer, one column: the Supervisor writes `employees.session_id` when
 * the engine reports the session it started. The id is not copied into
 * `conversations.director_session_id` as well — two writers of one value is
 * standing rule 6's shape. Compaction writes that column when it starts a
 * fresh session (row S1-18), which is the change it exists to record.
 */
describe("the Director's engine session survives a restart", () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let tokenRegistry: TokenRegistry;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-director-resume-'));
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
    port = await server.start();
  });

  afterEach(async () => {
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function hireDirector() {
    return hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' })
      .employee;
  }

  /** An engine that reports the session it started, and answers resume as told. */
  function engine(sessionId: string | null, resumeResults?: Record<string, boolean>) {
    return new FakeAdapter({
      keepOpen: true,
      capabilities: { mcpServers: true, sessionResume: true },
      ...(resumeResults ? { resumeResults } : {}),
      events:
        sessionId === null
          ? []
          : [{ t: 'session.started', sessionId, engineVersion: '2.1.276', model: null }],
    });
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
      containProcess: () => {},
      createAdapter: () => adapter,
      resolveToolsScriptPath: resolveBureauToolsScriptPathForTests,
    });
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  function events(type: string): { payload: Record<string, unknown> }[] {
    return readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === type);
  }

  it('records the session the engine started, on the employee row', async () => {
    const director = hireDirector();

    await start(engine('sess-alpha'));
    await settle();

    expect(getEmployeeById(db, director.id)?.session_id).toBe('sess-alpha');
    // No event of its own: the idle it caused carries the id.
    const idle = events('employee.idle');
    expect(idle.some((event) => event.payload?.['sessionId'] === 'sess-alpha')).toBe(true);
  });

  it('resumes that session on the next start, instead of beginning a new one', async () => {
    const director = hireDirector();
    const first = engine('sess-alpha');
    await start(first);
    await settle();
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();

    // A fresh process: new registry entry, new adapter, same database.
    const second = engine(null, { 'sess-alpha': true });
    await start(second);
    await settle();

    expect(second.resumedSessionIds).toEqual(['sess-alpha']);
    expect(getEmployeeById(db, director.id)?.session_id).toBe('sess-alpha');
  });

  it('starts fresh, and says so, when the engine refuses the stored session', async () => {
    const director = hireDirector();
    await start(engine('sess-alpha'));
    await settle();
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();

    const second = engine(null, { 'sess-alpha': false });
    await start(second);
    await settle();

    expect(second.resumedSessionIds).toEqual(['sess-alpha']);
    expect(getEmployeeById(db, director.id)?.session_id).toBeNull();
    expect(events('director.session_restarted')).toHaveLength(1);
  });
});
