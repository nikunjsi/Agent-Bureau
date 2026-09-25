import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { inDirectorTurn } from '../../helpers/directorTurn';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import { newId } from '../../../src/shared/models/ids';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * `${project}` for the Director (M11 row S1-11b).
 *
 * The variable is derived from the employee's worktree, and the Director
 * has none (§8.0), so it resolved to null — which matches nothing. Its own
 * `Read(${project}/**)` grant would then have denied every read: safe, and
 * blind. Its project is the one its conversation is about.
 *
 * Driven through the real policy endpoint with the real evaluator, the way
 * `policyRealEvaluator.test.ts` does, because the question is what the
 * shipped policy path answers — not what a rule table says in isolation.
 */
describe("the Director's project is the one its conversation is about", () => {
  let tmpDir: string;
  let baseDir: string;
  let projectDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let tokenRegistry: TokenRegistry;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-director-project-'));
    baseDir = path.join(tmpDir, 'userData');
    projectDir = path.join(tmpDir, 'home', 'the-project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, 'README.md'), '# hello', 'utf8');
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

  /** A conversation about a real project, which is what makes it active. */
  function conversationAboutAProject(): string {
    const project = insertProject(db, { name: 'The Project', path: projectDir, kind: 'software' });
    return insertConversation(db, {
      company_id: companyId,
      project_id: project.id,
      title: 'The Project',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    }).id;
  }

  async function runningDirectorToken(): Promise<string> {
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
      controlChannelPort: port,
      baseDir,
      secretBroker: noopSecretBroker,
      containProcess: () => {},
      createAdapter: () => adapter,
      resolveToolsScriptPath: resolveBureauToolsScriptPathForTests,
    });
    expect(result.status).toBe('started');
    return adapter.startedContext!.controlChannel.token;
  }

  function policyCheck(token: string, filePath: string): Promise<{ verdict: string }> {
    const body = JSON.stringify({
      callId: newId(),
      tool: 'Read',
      rawTool: 'Read',
      args: { file_path: filePath },
      preview: '',
    });
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/policy/check',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { verdict: string }),
          );
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  it('reads a file inside its active project', async () => {
    const conversationId = conversationAboutAProject();
    const token = await runningDirectorToken();
    await inDirectorTurn(db, supervisorRegistry, conversationId);

    const verdict = await policyCheck(token, path.join(projectDir, 'README.md'));

    expect(verdict.verdict).toBe('allow');
  });

  it('is denied a file outside it', async () => {
    const conversationId = conversationAboutAProject();
    const token = await runningDirectorToken();
    await inDirectorTurn(db, supervisorRegistry, conversationId);

    const verdict = await policyCheck(token, path.join(tmpDir, 'elsewhere.txt'));

    expect(verdict.verdict).toBe('deny');
  });

  // M11 S2-1a: the project is the turn's, so between turns there is none,
  // even with a project's conversation open. Fail closed (invariant #6).
  it('is denied between turns, even when a project has a conversation', async () => {
    conversationAboutAProject();
    const token = await runningDirectorToken();

    const verdict = await policyCheck(token, path.join(projectDir, 'README.md'));

    expect(verdict.verdict).toBe('deny');
  });

  it('is denied when there is no active project at all', async () => {
    // No conversation, so nothing to be "the project": the safe direction.
    const token = await runningDirectorToken();

    const verdict = await policyCheck(token, path.join(projectDir, 'README.md'));

    expect(verdict.verdict).toBe('deny');
  });
});
