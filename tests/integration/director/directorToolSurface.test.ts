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
import { getDirectorEmployee } from '../../../src/main/db/repositories/employees';
import { getEmployeeStateDir } from '../../../src/main/db/paths';
import { spawnSupervisedEmployee } from '../../../src/main/engine/spawnSupervisedEmployee';
import { ControlJsonSchema } from '../../../src/shared/controlChannel/schemas';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * Who may call what (M11 row S1-12a).
 *
 * The Director and an employee do different jobs, so they are offered
 * different tools — and the offer is not the enforcement. A tool belonging
 * to the other one is refused at the control channel, with the security
 * event that records it (§26 item 10's guardrails: the Director directs,
 * it does not build, and it cannot do an employee's reporting for it).
 */
describe('the Director and an employee get different tools, and the channel enforces it', () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-tool-surface-'));
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
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });
    tokenRegistry = new TokenRegistry();
    supervisorRegistry = new SupervisorRegistry();
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      baseDir,
    });
    port = await server.start();
  });

  afterEach(async () => {
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const engine = () =>
    new FakeAdapter({ keepOpen: true, capabilities: { mcpServers: true, sessionResume: true } });

  async function directorTarget(): Promise<{ url: string; token: string }> {
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' });
    const adapter = engine();
    const result = await startDirector({
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
    expect(result.status).toBe('started');
    return adapter.startedContext!.controlChannel;
  }

  /** A hired employee with a real token, spawned the production way. */
  async function employeeTarget(): Promise<{
    target: { url: string; token: string };
    controlJsonPath: string;
  }> {
    const employee = hireEmployee({
      db,
      activityLog,
      companyId,
      baseDir,
      roleKey: 'engineering:developer',
    }).employee;
    const spawned = await spawnSupervisedEmployee({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      controlChannelPort: port,
      employeeId: employee.id,
      adapter: engine(),
      baseDir,
    });
    return {
      target: { url: `http://127.0.0.1:${port}`, token: spawned.token },
      controlJsonPath: spawned.controlJsonPath,
    };
  }

  function securityEvents(): { payload: Record<string, unknown> }[] {
    return readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === 'control.authorization_rejected');
  }

  it("refuses an employee calling the Director's tool, and records it as a security event", async () => {
    const { target } = await employeeTarget();

    const result = await callBureauTool(target, 'bureau_report', {
      kind: 'report',
      body: 'I am the Director now',
      payload: { whatHappened: 'no' },
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/Director/);
    expect(securityEvents()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ tool: 'bureau_report', reason: 'wrong_role_for_tool' }),
      }),
    ]);
  });

  it("refuses the Director calling an employee's tool, the same way", async () => {
    const target = await directorTarget();

    const result = await callBureauTool(target, 'bureau_task_done', {
      summary: 'all done',
      verified: [],
      not_verified: [],
      artifacts: [],
    });

    expect(result.ok).toBe(false);
    expect(securityEvents()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          tool: 'bureau_task_done',
          reason: 'wrong_role_for_tool',
        }),
      }),
    ]);
  });

  it('still answers an unknown tool name as not built, without a security event', async () => {
    const target = await directorTarget();

    const result = await callBureauTool(target, 'bureau_make_coffee', {});

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/NOT_IMPLEMENTED/);
    expect(securityEvents()).toEqual([]);
  });

  it('control.json tells bureau-tools whose tools to serve, because only it knows', async () => {
    // bureau-tools is spawned by the engine CLI, so this file is the only
    // thing it can learn its own role from.
    const { controlJsonPath } = await employeeTarget();
    expect(
      ControlJsonSchema.parse(JSON.parse(readFileSync(controlJsonPath, 'utf8'))).isDirector,
    ).toBe(false);

    await directorTarget();
    const director = getDirectorEmployee(db)!;
    const directorControl = path.join(getEmployeeStateDir(baseDir, director.id), 'control.json');
    expect(
      ControlJsonSchema.parse(JSON.parse(readFileSync(directorControl, 'utf8'))).isDirector,
    ).toBe(true);
  });
});
