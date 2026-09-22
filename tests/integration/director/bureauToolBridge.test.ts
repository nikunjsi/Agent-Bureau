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
import { EMPLOYEE_TOOL_HANDLERS } from '../../../src/main/controlChannel/toolHandlers';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import { callBureauTool, targetFromContext } from '../../helpers/bureauToolBridge';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';
import type { ToolHandler } from '../../../src/main/controlChannel/toolHandlers/types';

/**
 * A scripted turn's tool call goes through the real control channel
 * (M11 row S1-11a). Without this, every later Director test — the tools
 * (S1-12), the producer (S1-13), M9's deferred gate (S2-7) and the
 * behaviour tests (S3-11) — would either bypass the real handlers or need
 * a stand-in, which standing rule 1 forbids.
 */
describe('a scripted turn calls a Bureau tool over the real control channel', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let tokenRegistry: TokenRegistry;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let port: number;

  async function startServer(
    toolHandlers?: Record<string, ToolHandler>,
  ): Promise<ControlChannelServer> {
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      ...(toolHandlers ? { toolHandlers } : {}),
    });
    port = await server.start();
    return server;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-tool-bridge-'));
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
  });

  afterEach(async () => {
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runningDirector(adapter: FakeAdapter) {
    const director = hireEmployee({
      db,
      activityLog,
      companyId,
      baseDir,
      roleKey: 'operations:director',
    }).employee;
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
    return director;
  }

  const engine = () =>
    new FakeAdapter({ keepOpen: true, capabilities: { mcpServers: true, sessionResume: true } });

  it('the Core records what the tool did, and the turn sees the result', async () => {
    await startServer();
    const adapter = engine();
    const director = await runningDirector(adapter);
    const ctx = adapter.startedContext!;

    // Step one of a scripted turn: the agent calls a tool.
    const first = await callBureauTool(targetFromContext(ctx), 'bureau_report_status', {
      status_detail: 'reading the workspace',
    });

    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(getEmployeeById(db, director.id)?.status_detail).toBe('reading the workspace');
    const types = readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toContain('employee.status_reported');

    // Step two: the result of step one is in hand, so a scripted turn can
    // branch on it exactly as a real agent would.
    expect(Object.keys(first)).toContain('ok');
  });

  it('a handler that throws comes back as the tool call failing, not as silence', async () => {
    const exploding: ToolHandler = () => {
      throw new Error('handler blew up');
    };
    await startServer({ ...EMPLOYEE_TOOL_HANDLERS, bureau_report_status: exploding });
    const adapter = engine();
    await runningDirector(adapter);
    const ctx = adapter.startedContext!;

    const result = await callBureauTool(targetFromContext(ctx), 'bureau_report_status', {
      status_detail: 'anything',
    });

    // A structured failure the agent can act on (§7.9: "never a crash"),
    // not a dropped request and not a dead channel. The message reaches the
    // agent, which is the right direction: it is the caller, not the user,
    // and CLAUDE.md's "translate, never show raw" is about what the USER
    // sees.
    expect(result.ok).toBe(false);
    expect(result['error']).toMatchObject({ code: 'INTERNAL_ERROR' });

    // And the channel is still serving: the next scripted step works.
    const after = await callBureauTool(targetFromContext(ctx), 'bureau_read_memory', {
      query: 'x',
    });
    expect(after.ok, JSON.stringify(after)).toBe(true);
  });

  it('refuses a call that carries no valid token, the way the real server does', async () => {
    await startServer();
    const adapter = engine();
    await runningDirector(adapter);
    const ctx = adapter.startedContext!;

    const result = await callBureauTool(
      { url: targetFromContext(ctx).url, token: 'not-a-real-token' },
      'bureau_report_status',
      { status_detail: 'anything' },
    );

    expect(result.ok).toBe(false);
  });
});
