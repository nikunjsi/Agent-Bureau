import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../src/main/db/settingsLoader';
import { ActivityLog } from '../../src/main/db/activityLog';
import { Supervisor } from '../../src/main/engine/supervisor';
import { SupervisorRegistry } from '../../src/main/engine/supervisorRegistry';
import { ProbeCache } from '../../src/main/engine/probeCache';
import { FakeAdapter } from '../../src/main/engine/fakeAdapter';
import { getEmployeeById } from '../../src/main/db/repositories/employees';
import { runShutdownSequence } from '../../src/main/shutdownSequence';
import { seedEmployee, seedProject, seedRole, seedTask } from '../helpers/dbFixtures';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../src/shared/engine/seams';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * D-2 / §7.11: **quitting stops the employees.**
 *
 * The shutdown sequence stopped every timer, the router, the streams, the
 * broadcast and the control channel — and no Supervisor. That was survivable
 * only because nothing in production hires yet: the first real hire at M11
 * would have meant quitting Bureau while its employees' engine processes kept
 * running, with their `employees.status` rows left claiming `working` for the
 * next launch's `reconcile()` to clean up.
 *
 * **Before the control channel drains**, deliberately. An employee stopping
 * may have a tool call in flight, and that call is served by the channel; if
 * the channel went first, the stop would be racing a server that had already
 * refused its request. Stopping the employees first means no NEW turn begins,
 * and the drain that follows is what waits for whatever was already in the
 * air (bounded, as it already was).
 */
describe('the shutdown sequence stops live Supervisors (D-2)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let registry: SupervisorRegistry;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-shutdown-sup-'));
    dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    registry = new SupervisorRegistry();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * The row, read AFTER the shutdown — which closes the database it was
   * written through. A second connection to the same file is the only
   * honest way to ask "what did the quit leave behind", and it is what the
   * next launch would see.
   */
  function statusAfterQuit(employeeId: string): string {
    const reopened = openConnection(dbPath);
    try {
      return getEmployeeById(reopened, employeeId)?.status ?? 'missing';
    } finally {
      reopened.close();
    }
  }

  /** A real Supervisor, really assigned, with a real (fake-engine) session. */
  async function runningEmployee(): Promise<{ id: string; adapter: FakeAdapter }> {
    const role = seedRole(db);
    const employee = seedEmployee(db, { role_key: role.full_key });
    const project = seedProject(db);
    const task = seedTask(db, { project_id: project.id });
    const adapter = new FakeAdapter({ keepOpen: true });
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter,
      probeCache: new ProbeCache(),
    });
    await supervisor.assign({
      employee,
      role,
      task,
      worktreePath: path.join(tmpDir, 'wt'),
      stateDir: path.join(tmpDir, 'state'),
      baseDir: path.join(tmpDir, 'state'),
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });
    registry.register(employee.id, supervisor);
    return { id: employee.id, adapter };
  }

  function shutdown(order: string[]): Promise<void> {
    // The registry, wrapped only to record WHEN each stop happened — the
    // supervisors themselves are the real ones.
    const observed = {
      all: () =>
        registry.all().map(({ employeeId, supervisor }) => ({
          employeeId,
          supervisor: {
            stop: async (graceMs?: number) => {
              order.push('supervisor.stopped');
              await supervisor.stop(graceMs);
            },
          },
        })),
    };
    return runShutdownSequence({
      supervisors: observed,
      controlChannelServer: {
        stop: async () => {
          order.push('channel.drain');
          await Promise.resolve();
        },
      },
      resumeTick: { stop: () => order.push('resumeTick.stop') },
      checkpointTick: { stop: () => order.push('checkpointTick.stop') },
      messageRouter: { stop: () => order.push('messageRouter.stop') },
      stopLiveState: () => order.push('stopLiveState'),
      chatStreams: { abortAll: () => 0 },
      activityLog,
      db,
    });
  }

  it('stops a live employee, and the row says so afterwards', async () => {
    const { id } = await runningEmployee();
    expect(getEmployeeById(db, id)?.status).not.toBe('off');

    await shutdown([]);

    expect(statusAfterQuit(id)).toBe('off');
  });

  it('stops every one of them, not just the first', async () => {
    const a = await runningEmployee();
    const b = await runningEmployee();

    await shutdown([]);

    expect(statusAfterQuit(a.id)).toBe('off');
    expect(statusAfterQuit(b.id)).toBe('off');
  });

  it('stops them BEFORE the control channel drains', async () => {
    // The order is the point: a stop racing a closed channel is a stop that
    // cannot finish what it started.
    await runningEmployee();
    const order: string[] = [];

    await shutdown(order);

    const drain = order.indexOf('channel.drain');
    expect(drain).toBeGreaterThanOrEqual(0);
    expect(order.slice(0, drain)).toContain('supervisor.stopped');
  });

  it('quits even when one employee refuses to stop', async () => {
    // A wedged engine must not strand the user in an app that will not
    // quit — the same rule the channel drain already follows.
    const { id } = await runningEmployee();
    const supervisor = registry.get(id);
    if (supervisor === undefined) throw new Error('registry lost the supervisor');
    Object.assign(supervisor, {
      stop: () => new Promise<void>(() => {}),
    });

    await expect(shutdown([])).resolves.toBeUndefined();
  });
});
