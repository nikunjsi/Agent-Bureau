import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee } from '../../../src/main/db/repositories/employees';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';
import { adapterTestContext } from '../../helpers/adapterContext';

/**
 * A send queued before a park must not launch a new billed turn when the
 * running child exits (M11 row S1-10; pre-M11 §F, from N-1).
 *
 * The adapter's `exit` handler flushed the queue unconditionally, so a park
 * that arrived mid-turn was followed by a fresh `claude -p` the moment the
 * turn ended. Its usage is recorded (N-1), but the turn still ran and still
 * cost money Bureau had already decided not to spend.
 *
 * Driven against the REAL adapter (standing rule 1), with Node standing in
 * for the engine binary, because the queue and the exit handler are the
 * things under test.
 */
describe('a send queued before a park does not start another turn', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** `launches` counts real delivery attempts: buildLaunchSpec runs once per turn. */
  function realAdapter() {
    let launches = 0;
    const adapter = new ClaudeCodeAdapter({
      resolveBureauHookScriptPath: () => {
        launches += 1;
        return path.resolve('dist/resources/bin/bureau-hook.js');
      },
      resolveBinary: async () => ({ resolvedPathString: '', binaryPath: process.execPath }),
    });
    cleanups.push(() => adapter.stop());
    return { adapter, launches: () => launches };
  }

  // `node -p <text>`: a real process that ends on its own, quickly.
  const SHORT_TURN = '1+1';

  it('holds the queued send while the gate is closed, and launches nothing on exit', async () => {
    const { adapter, launches } = realAdapter();
    const ctx = adapterTestContext('claude-code', { mode: 'structured' });
    await adapter.start(ctx);
    await adapter.buildLaunchSpec(ctx);
    let mayDeliver = true;
    adapter.setDeliveryGate(() => mayDeliver);

    await adapter.send(SHORT_TURN, 'task');
    const afterFirst = launches();
    // Queued behind the running turn, then the Supervisor parks.
    await adapter.send(SHORT_TURN, 'task');
    mayDeliver = false;

    // Long enough for the first child to exit and the exit handler to run.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(launches() - afterFirst, 'the queued send launched a new turn after the park').toBe(0);
  }, 20_000);

  it('dropQueuedSends clears what is waiting and says how much it dropped', async () => {
    const { adapter } = realAdapter();
    const ctx = adapterTestContext('claude-code', { mode: 'structured' });
    await adapter.start(ctx);
    await adapter.buildLaunchSpec(ctx);

    await adapter.send(SHORT_TURN, 'task');
    await adapter.send(SHORT_TURN, 'task');
    await adapter.send(SHORT_TURN, 'task');

    expect(adapter.dropQueuedSends()).toBe(2);
    expect(adapter.dropQueuedSends()).toBe(0);
  }, 20_000);
});

/**
 * The Supervisor's half: parking is what closes the gate, and it drops what
 * is waiting rather than leaving it to be flushed later. One place decides
 * it — `transition()` — so every park does it: budget, quota and a user
 * pause alike.
 */
describe('parking drops the queued sends, and says how many', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-park-drop-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: path.resolve('src/main/db/migrations'),
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    const now = nowIso();
    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', '{}', now, now);
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a user pause mid-turn drops the queue and records the count on the park', async () => {
    const role = insertRole(db, {
      key: `developer-${newId()}`,
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes code',
      system_prompt_path: 'prompts/developer.md',
      skills: [],
      deliverable_types: [],
      engine_preference: ['fake'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: [],
      autonomy_default: 'guided',
      sprite_key: 'dev',
    } as never);
    const employee = insertEmployee(db, {
      name: `Quinn-${newId()}`,
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'off',
      engine: 'fake',
      autonomy: 'guided',
    } as never);

    const adapter = new FakeAdapter({ keepOpen: true });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    const ctx: EmployeeContext = {
      employee,
      role,
      task: null,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };
    await supervisor.assign(ctx);

    // A real turn is running, so two sends queue behind it.
    adapter.pushEvent({ t: 'turn.started', turnIndex: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await adapter.send('one', 'task');
    await adapter.send('two', 'task');

    await supervisor.pause();

    const parked = readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === 'employee.parked');

    expect(parked).toHaveLength(1);
    expect(parked[0]?.payload).toMatchObject({ reason: 'user_paused', droppedSends: 2 });
    // Nothing is left to be flushed by a later idle.
    expect(adapter.dropQueuedSends()).toBe(0);
    await supervisor.stop();
  }, 20_000);
});
