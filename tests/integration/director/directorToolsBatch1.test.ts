import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { spawnSupervisedEmployee } from '../../../src/main/engine/spawnSupervisedEmployee';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import { callBureauTool, type ControlChannelTarget } from '../../helpers/bureauToolBridge';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertTask } from '../../../src/main/db/repositories/tasks';
import { getMemoryDir } from '../../../src/main/db/paths';

/**
 * M11 row S1-12b — the Director's remaining batch-1 tools, over the real
 * control channel: `bureau_get_project_state`, `bureau_write_memory` and
 * `bureau_search_workspace`.
 *
 * Two of the three touch the filesystem on an agent's say-so, and both are
 * `bureau_` tools, which `evaluator.ts` short-circuits to `allow` before a
 * single immutable deny is scanned (§23.2, CLAUDE.md invariant #5's
 * carve-out). **So the guard is the handler, and it is tested here, at the
 * handler** — including against a junction, which is the one escape the
 * syntactic checks cannot see.
 */
// The row ID stays in the comment above and out of every title (plan §F,
// S1-5): `securitySuiteCoverage` reads an S-number out of test code.
describe("the Director's batch-1 tools", () => {
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-director-tools-'));
    baseDir = path.join(tmpDir, 'userData');
    projectDir = path.join(tmpDir, 'project');
    mkdirSync(projectDir, { recursive: true });
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

  async function directorTarget(): Promise<ControlChannelTarget> {
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

  async function employeeTarget(): Promise<ControlChannelTarget> {
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
    return { url: `http://127.0.0.1:${port}`, token: spawned.token };
  }

  /** The project the Director is on — the one its conversation is about. */
  function seedProjectOnConversation(): { id: string; displayKey: string } {
    const project = insertProject(db, {
      name: 'Widget',
      path: projectDir,
      kind: 'software',
    } as never);
    insertConversation(db, {
      company_id: companyId,
      project_id: project.id,
      title: 'Widget',
    } as never);
    return { id: project.id, displayKey: project.display_key };
  }

  function securityEvents(): { payload: Record<string, unknown> }[] {
    return readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === 'control.authorization_rejected');
  }

  // ---- bureau_get_project_state ----

  it('bureau_get_project_state answers with the tasks, their statuses, the spend and the blockers', async () => {
    const target = await directorTarget();
    const project = seedProjectOnConversation();
    const done = insertTask(db, {
      project_id: project.id,
      title: 'Ship the thing',
      body: 'b',
      acceptance_criteria: ['it ships'],
    });
    const blocked = insertTask(db, {
      project_id: project.id,
      title: 'Blocked thing',
      body: 'b',
      acceptance_criteria: ['it unblocks'],
    });
    db.prepare("UPDATE tasks SET status = 'done', spend_usd_micros = 120000 WHERE id = ?").run(
      done.id,
    );
    db.prepare(
      "UPDATE tasks SET status = 'blocked', status_reason = 'needs a decision' WHERE id = ?",
    ).run(blocked.id);
    db.prepare('UPDATE projects SET spend_usd_micros = 250000 WHERE id = ?').run(project.id);

    const result = await callBureauTool(target, 'bureau_get_project_state', {});

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const data = (result as unknown as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      project: expect.objectContaining({
        displayKey: project.displayKey,
        name: 'Widget',
        spendUsdMicros: 250_000,
      }),
    });
    const tasks = data['tasks'] as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t['status']).sort()).toEqual(['blocked', 'done']);
    expect(tasks.find((t) => t['status'] === 'done')).toMatchObject({ spendUsdMicros: 120_000 });
    expect(data['blockers']).toEqual([
      expect.objectContaining({ title: 'Blocked thing', reason: 'needs a decision' }),
    ]);
  });

  it('bureau_get_project_state says so plainly when there is no project yet', async () => {
    const target = await directorTarget();

    const result = await callBureauTool(target, 'bureau_get_project_state', {});

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/no project/i);
  });

  // ---- bureau_write_memory ----

  it('bureau_write_memory writes project scope directly — no checkpoint', async () => {
    const target = await directorTarget();
    seedProjectOnConversation();

    const result = await callBureauTool(target, 'bureau_write_memory', {
      scope: 'project',
      path: 'decisions-so-far.md',
      content: '# Decisions\n\nWe chose SQLite.',
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((result as unknown as { data: Record<string, unknown> }).data).toMatchObject({
      applied: true,
    });
    const written = path.join(getMemoryDir(baseDir), 'project', 'decisions-so-far.md');
    expect(readFileSync(written, 'utf8')).toMatch(/We chose SQLite/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get()).toMatchObject({ n: 0 });
  });

  it('bureau_write_memory still asks for company scope, through the one function that decides', async () => {
    const target = await directorTarget();
    seedProjectOnConversation();

    const result = await callBureauTool(target, 'bureau_write_memory', {
      scope: 'company',
      path: 'standards.md',
      content: '# Standards\n\nAlways write tests.',
      rationale: 'The user said this twice.',
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((result as unknown as { data: Record<string, unknown> }).data).toMatchObject({
      applied: false,
    });
    // Not written yet: an approval that has not happened is not a write.
    expect(() =>
      readFileSync(path.join(getMemoryDir(baseDir), 'company', 'standards.md'), 'utf8'),
    ).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get()).toMatchObject({ n: 1 });
  });

  it('bureau_write_memory refuses a path that leaves the memory tree through a junction', async () => {
    const target = await directorTarget();
    seedProjectOnConversation();
    // A real link inside the memory tree pointing at somewhere else on
    // disk: every syntactic check passes and only canonicalisation sees it.
    const outside = path.join(tmpDir, 'outside');
    mkdirSync(outside, { recursive: true });
    const projectScope = path.join(getMemoryDir(baseDir), 'project');
    mkdirSync(projectScope, { recursive: true });
    symlinkSync(outside, path.join(projectScope, 'escape'), 'junction');

    const result = await callBureauTool(target, 'bureau_write_memory', {
      scope: 'project',
      path: 'escape/stolen.md',
      content: 'should never be written',
    });

    expect(result.ok).toBe(false);
    expect(() => readFileSync(path.join(outside, 'stolen.md'), 'utf8')).toThrow();
  });

  // ---- bureau_search_workspace ----

  it('bureau_search_workspace greps the project and returns matches with their lines', async () => {
    const target = await directorTarget();
    seedProjectOnConversation();
    mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'const needle = 1;\nconst other = 2;\n');
    writeFileSync(path.join(projectDir, 'src', 'b.md'), 'no match here\n');
    writeFileSync(path.join(projectDir, 'src', 'c.ts'), 'needle again\n');

    const result = await callBureauTool(target, 'bureau_search_workspace', {
      pattern: 'needle',
      glob: '**/*.ts',
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const matches = (result as unknown as { data: { matches: Array<Record<string, unknown>> } })
      .data.matches;
    expect(matches.map((m) => m['path']).sort()).toEqual(['src/a.ts', 'src/c.ts']);
    expect(matches.find((m) => m['path'] === 'src/a.ts')).toMatchObject({
      line: 1,
      text: 'const needle = 1;',
    });
  });

  it('bureau_search_workspace honours max_results and says it truncated', async () => {
    const target = await directorTarget();
    seedProjectOnConversation();
    for (let i = 0; i < 6; i++) {
      writeFileSync(path.join(projectDir, `f${i}.txt`), 'needle\n');
    }

    const result = await callBureauTool(target, 'bureau_search_workspace', {
      pattern: 'needle',
      max_results: 2,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const data = (result as unknown as { data: Record<string, unknown> }).data;
    expect((data['matches'] as unknown[]).length).toBe(2);
    expect(data['truncated']).toBe(true);
  });

  it('bureau_search_workspace does not follow a junction out of the project', async () => {
    const target = await directorTarget();
    seedProjectOnConversation();
    const outside = path.join(tmpDir, 'secrets');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'keys.txt'), 'needle: the private key\n');
    symlinkSync(outside, path.join(projectDir, 'link'), 'junction');
    writeFileSync(path.join(projectDir, 'inside.txt'), 'needle inside\n');

    const result = await callBureauTool(target, 'bureau_search_workspace', {
      pattern: 'needle',
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const matches = (result as unknown as { data: { matches: Array<Record<string, unknown>> } })
      .data.matches;
    expect(matches.map((m) => m['path'])).toEqual(['inside.txt']);
    expect(JSON.stringify(matches)).not.toMatch(/private key/);
  });

  it('bureau_search_workspace fails closed when the Director is between projects', async () => {
    const target = await directorTarget();

    const result = await callBureauTool(target, 'bureau_search_workspace', { pattern: 'needle' });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/no project/i);
  });

  // ---- who may call them ----

  it('refuses an employee calling any of the three, with a security event each', async () => {
    const target = await employeeTarget();
    seedProjectOnConversation();

    const calls = [
      ['bureau_get_project_state', {}],
      ['bureau_write_memory', { scope: 'project', path: 'x.md', content: 'x' }],
      ['bureau_search_workspace', { pattern: 'x' }],
    ] as const;
    for (const [name, args] of calls) {
      const result = await callBureauTool(target, name, args);
      expect(result.ok, `${name} must be refused for an employee`).toBe(false);
    }

    expect(securityEvents().map((e) => e.payload['tool'])).toEqual([
      'bureau_get_project_state',
      'bureau_write_memory',
      'bureau_search_workspace',
    ]);
    expect(securityEvents().every((e) => e.payload['reason'] === 'wrong_role_for_tool')).toBe(true);
  });
});
