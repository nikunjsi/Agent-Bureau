import type Database from 'better-sqlite3';
import type { ActivityLog } from '../../src/main/db/activityLog';
import { Supervisor } from '../../src/main/engine/supervisor';
import { FakeAdapter } from '../../src/main/engine/fakeAdapter';
import { SupervisorRegistry } from '../../src/main/engine/supervisorRegistry';
import { getRoleByFullKey } from '../../src/main/db/repositories/roles';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../src/shared/engine/seams';
import type { Employee } from '../../src/shared/models/employee';
import type { AgentEvent } from '../../src/shared/engine/events';

/**
 * Spawns a REAL `Supervisor` over a `FakeAdapter` and registers it, the way
 * `spawnSupervisedEmployee` will once M11 has an assignment flow to call
 * it. Shared by the router tests, which all need the same thing: an
 * employee that is genuinely live and genuinely idle, so
 * `deliverabilityOf` sees what it would see in production.
 *
 * **This is fixture construction, not a stand-in** (standing rule 1). The
 * `Supervisor` is the production class, `assign()` is the production entry
 * point, and the `send()` the router ends up calling is
 * `EngineAdapter.send`'s real §7.4 implementation. What is faked is the
 * engine process — the same thing `FakeAdapter` fakes everywhere else.
 */
export interface LiveEmployeeOptions {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly supervisorRegistry: SupervisorRegistry;
  readonly employee: Employee;
  readonly stateDir: string;
  /** Defaults to a single `session.started`, which lands the supervisor on
   *  `idle` — the state a router delivery requires. */
  readonly events?: AgentEvent[];
  /** Keeps the adapter's event stream open so a test can drive a turn
   *  boundary AFTER doing something (see FakeAdapter.pushEvent). */
  readonly keepOpen?: boolean;
}

export interface LiveEmployee {
  readonly supervisor: Supervisor;
  readonly adapter: FakeAdapter;
}

export async function startLiveIdleEmployee(options: LiveEmployeeOptions): Promise<LiveEmployee> {
  const role = getRoleByFullKey(options.db, options.employee.role_key);
  if (role === null) throw new Error(`no role row for ${options.employee.role_key}`);

  const adapter = new FakeAdapter({
    events: options.events ?? [
      { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
    ],
    ...(options.keepOpen === true ? { keepOpen: true } : {}),
  });
  const supervisor = new Supervisor(options.employee.id, {
    db: options.db,
    activityLog: options.activityLog,
    adapter,
    supervisorRegistry: options.supervisorRegistry,
    // Real, but far longer than any test here can run: the point is
    // "never fires", not "fires eventually".
    heartbeatCheckIntervalMs: 999_999_999,
  });

  await supervisor.assign({
    employee: options.employee,
    role,
    task: null,
    worktreePath: options.stateDir,
    stateDir: options.stateDir,
    baseDir: options.stateDir,
    toolServer: placeholderToolServer,
    controlChannel: placeholderControlChannel,
    broker: noopSecretBroker,
    modelId: null,
    turnBudgetCapUsdMicros: null,
  });
  options.supervisorRegistry.register(options.employee.id, supervisor);

  // The supervisor consumes its adapter's events on a background loop; the
  // scripted `session.started` is what puts it in `idle`. Waiting for the
  // real state rather than sleeping a fixed amount keeps this from being a
  // timing assumption.
  await waitForState(supervisor, 'idle');
  return { supervisor, adapter };
}

export async function waitForState(
  supervisor: Supervisor,
  state: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (supervisor.currentState !== state) {
    if (Date.now() > deadline) {
      throw new Error(
        `supervisor never reached '${state}' (still '${supervisor.currentState}' after ${timeoutMs}ms)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
