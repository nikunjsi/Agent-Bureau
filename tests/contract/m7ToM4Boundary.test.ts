import { PROBE_LIVENESS_CEILING_MS } from '../../src/shared/engine/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { ActivityLog } from '../../src/main/db/activityLog';
import { ControlChannelServer } from '../../src/main/controlChannel/server';
import { TokenRegistry } from '../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../src/main/engine/supervisorRegistry';
import { ProbeCache } from '../../src/main/engine/probeCache';
import { FakeAdapter } from '../../src/main/engine/fakeAdapter';
import {
  spawnSupervisedEmployee,
  buildControlChannelAndToolServerContext,
} from '../../src/main/engine/spawnSupervisedEmployee';
import { hireEmployee } from '../../src/main/company/hireEmployee';
import { getRoleByFullKey } from '../../src/main/db/repositories/roles';
import { getEmployeeById } from '../../src/main/db/repositories/employees';
import { insertProject } from '../../src/main/db/repositories/projects';
import { insertTask, getTaskById } from '../../src/main/db/repositories/tasks';
import { getMemoryDir } from '../../src/main/db/paths';
import { searchMemory } from '../../src/main/memory/searchMemory';
import { writeMemory } from '../../src/main/memory/memoryStore';
import { noopSecretBroker } from '../../src/shared/engine/seams';
import { setSetting } from '../../src/main/db/repositories/settings';
import { SHIPPING_MODEL_TIERS } from '../../src/main/engine/modelTiers';
import { employeesHandlers } from '../../src/main/ipc/handlers/employees';
import { getDbPaths } from '../../src/main/db/paths';
import { loadPricingYaml } from '../../src/main/cost/pricingYaml';
import type { HandlerContext } from '../../src/main/ipc/handlers/types';
import { seedCompany, installShippedPack } from '../helpers/companyFixture';
import { resolveBureauToolsScriptPathForTests } from '../helpers/realEngineAdapter';
import type { EmployeeContext } from '../../src/shared/engine/types';
import type { Employee } from '../../src/shared/models/employee';
import type { ProbeResult } from '../../src/shared/engine/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * # The M7 → M4 boundary check
 *
 * M4's gate proved a **hand-constructed** employee works end to end. M7
 * built a **different** construction path — name allocation, desk, sprite
 * variant, memory creation, tier choice, `employees.model_tier_override`. The two
 * have never been connected, and M7's own close-out says so: "hiring
 * creates a row and a desk, not a running process."
 *
 * Every piece passes its own test. This file tests the JOIN, which is
 * where this project's largest bugs have all lived.
 *
 * ## What this file can and cannot reach, stated rather than implied
 *
 * **There is no production path from a hired employee to an
 * `EmployeeContext`.** Nothing in `src/` composes one —
 * `spawnSupervisedEmployee` explicitly disclaims it ("the caller still
 * owns the role/task/worktree/memory parts of the context"), and every
 * builder in the repo is a test. So the composition below is TEST-OWNED,
 * and per standing rule 1 that is said in the test names rather than in a
 * comment that reads like proof.
 *
 * What the composition does NOT fake is anything M7 or M3 owns: the
 * employee row, the role, the desk, the model, the memory and the
 * supervisor's own resolution are all real and all asserted against the
 * real production functions that produced them.
 *
 * ## Cost
 *
 * Nothing here spends money. The end-to-end "a hired employee does real
 * work" run belongs with the gated `realAgentGate` family; this file
 * exists to be runnable in CI, because the one thing this project has
 * learned about opt-in tests is that they rot silently (Known Issues,
 * 2026-09-05: `realEngineSpawn.test.ts` threw for a whole milestone
 * because nothing ran it).
 */

interface Harness {
  db: Database.Database;
  activityLog: ActivityLog;
  tmpDir: string;
  baseDir: string;
  companyId: string;
  tokenRegistry: TokenRegistry;
  supervisorRegistry: SupervisorRegistry;
  server: ControlChannelServer;
  port: number;
}

/**
 * The context composition that has no production home. Deliberately
 * minimal: everything except the four fields M4 owns comes straight off
 * the real rows M7 wrote.
 */
function composeContextForHiredEmployee(
  h: Harness,
  employee: Employee,
  spawned: Awaited<ReturnType<typeof spawnSupervisedEmployee>>,
  taskId: string | null,
  worktreePath: string,
): EmployeeContext {
  const role = getRoleByFullKey(h.db, employee.role_key);
  if (role === null) throw new Error(`role ${employee.role_key} vanished`);
  return {
    employee,
    role,
    task: taskId === null ? null : getTaskById(h.db, taskId),
    worktreePath,
    stateDir: spawned.stateDir,
    // M10: the real userData root, so `assign()` composes §12.3's pack from
    // the memory tree hiring actually wrote into. Before M10 this was
    // `memoryPack: ''` — a string a caller supplied and nothing read; see
    // POINT 2b below, which used to assert that absence and now asserts the
    // wiring that replaced it.
    baseDir: h.baseDir,
    broker: noopSecretBroker,
    // Whatever a caller puts here is OVERWRITTEN by `Supervisor.assign()`,
    // which resolves the tier itself and is the ONLY place that decides a
    // model (migration 0008). Seeded with the recorded value so a caller
    // that never reached assign() still has something coherent.
    modelId: employee.model,
    turnBudgetCapUsdMicros: null,
    // Known Issues, 2026-09-05: the real resolver reads Electron's `app`,
    // which plain-Node vitest does not have — the documented shared helper
    // is the fix, and using it is what keeps this file from rotting the
    // way `realEngineSpawn.test.ts` did for a milestone.
    ...buildControlChannelAndToolServerContext(spawned, resolveBureauToolsScriptPathForTests),
  };
}

describe('M7 → M4 boundary: a hired employee reaches a real Supervisor', () => {
  let h: Harness;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-m7m4-'));
    const baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    const db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    const activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    const companyId = seedCompany(db, path.join(tmpDir, 'home')).id;
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });

    const tokenRegistry = new TokenRegistry();
    const supervisorRegistry = new SupervisorRegistry();
    const server = new ControlChannelServer({ db, activityLog, tokenRegistry, supervisorRegistry });
    const port = await server.start();

    h = {
      db,
      activityLog,
      tmpDir,
      baseDir,
      companyId,
      tokenRegistry,
      supervisorRegistry,
      server,
      port,
    };
  });

  afterEach(async () => {
    await h.server.stop();
    h.db.close();
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  function hire(roleKey = 'engineering:developer', extra: Record<string, unknown> = {}) {
    return hireEmployee({
      db: h.db,
      activityLog: h.activityLog,
      companyId: h.companyId,
      baseDir: h.baseDir,
      roleKey,
      ...extra,
    }).employee;
  }

  async function spawnAndAssign(
    employee: Employee,
    adapter: FakeAdapter,
    taskId: string | null = null,
    probeCache?: ProbeCache,
  ) {
    const spawned = await spawnSupervisedEmployee({
      db: h.db,
      activityLog: h.activityLog,
      tokenRegistry: h.tokenRegistry,
      supervisorRegistry: h.supervisorRegistry,
      controlChannelPort: h.port,
      employeeId: employee.id,
      adapter,
      baseDir: h.baseDir,
      ...(probeCache ? { supervisorOptions: { probeCache } } : {}),
    });
    const worktreePath = mkdtempSync(path.join(tmpdir(), 'bureau-m7m4-wt-'));
    const ctx = composeContextForHiredEmployee(h, employee, spawned, taskId, worktreePath);
    await spawned.supervisor.assign(ctx);
    return { spawned, worktreePath };
  }

  // --- JOIN POINT 4: does an M7 row satisfy assign() at all? -------------

  it('POINT 4: an employee row built by hireEmployee is accepted by Supervisor.assign()', async () => {
    // Nothing had ever handed `assign()` a row this path produced. It
    // reads role, task, worktree, broker, budget columns and capabilities,
    // and a hired row differs from the hand-built ones every prior test
    // used (real role_key, real desk, real sprite, real model, real
    // autonomy from the role).
    const employee = hire();
    const adapter = new FakeAdapter();

    const { spawned } = await spawnAndAssign(employee, adapter);

    expect(adapter.startedContext, 'assign() never reached the adapter').not.toBeNull();
    expect(spawned.supervisor.currentState).not.toBe('failed');
    expect(getEmployeeById(h.db, employee.id)!.status).not.toBe('failed');
    // The control channel really was provisioned for this employee.
    expect(existsSync(spawned.controlJsonPath)).toBe(true);

    await spawned.supervisor.stop(0);
  });

  it('POINT 4b: the hired employee carries a real task through to the adapter', async () => {
    const employee = hire();
    const project = insertProject(h.db, { name: 'boundary', path: h.tmpDir, kind: 'software' });
    const task = insertTask(h.db, {
      project_id: project.id,
      title: 'boundary task',
      body: 'Say hello and stop.',
      acceptance_criteria: ['it ran'],
    });
    const adapter = new FakeAdapter();

    const { spawned } = await spawnAndAssign(employee, adapter, task.id);

    // Presence before identity — an absent context would make the field
    // assertion below vacuous.
    expect(adapter.startedContext).not.toBeNull();
    expect(adapter.startedContext!.task?.id).toBe(task.id);
    expect(adapter.startedContext!.employee.id).toBe(employee.id);

    await spawned.supervisor.stop(0);
  });

  // --- JOIN POINT 1: does employees.model reach the spawn? --------------

  it('POINT 1: the TIER an employee is hired on is the tier it spawns on — proven on the real hire→spawn path', async () => {
    // §7.5 and the 2026-09-02 parking-lot decision: the Director may
    // judge that THIS work needs a different tier than the role's author
    // chose. The shipped developer role declares [balanced, capable];
    // this hire asks for 'fast'.
    //
    // This test was an `it.fails` on 2026-09-07, capturing the boundary
    // check's finding: hiring resolved a model id, stored it, and
    // `Supervisor.assign()` re-resolved from the role and discarded it.
    // Fixed by storing the CHOICE (a tier) and resolving once, at spawn.
    // Confirmed failing before that change with:
    //   expected 'claude-sonnet-5' to be 'claude-haiku-4-5-20251001'
    //
    // The assertion is on the model that reached the ADAPTER, not on a
    // column — the whole lesson of the boundary check is that both
    // halves were individually correct and the bug lived in the join.
    const employee = hire('engineering:developer', { modelTier: 'fast' });
    expect(employee.model_tier_override, 'the hire records the CHOICE').toBe('fast');

    const adapter = new FakeAdapter();
    const { spawned } = await spawnAndAssign(employee, adapter);

    // Presence before identity.
    expect(adapter.startedContext).not.toBeNull();
    const launchedWith = adapter.startedContext!.modelId;
    expect(launchedWith, 'a fast-tier hire must launch on the fast model').toBe(
      SHIPPING_MODEL_TIERS['claude-code']!.fast,
    );
    // And it is NOT the role's own tier, or this would pass vacuously
    // for a role that happened to declare fast.
    expect(launchedWith).not.toBe(SHIPPING_MODEL_TIERS['claude-code']!.balanced);

    // The record of what launched agrees with what launched.
    expect(getEmployeeById(h.db, employee.id)!.model).toBe(launchedWith);

    await spawned.supervisor.stop(0);
  });

  it('POINT 1a: no override means the ROLE decides, exactly as before — the fix did not invert the default', async () => {
    // The normal case, and the thing most easily broken by "make the
    // employee win": an employee with no override must still track its
    // role's declared tier.
    const employee = hire();
    expect(employee.model_tier_override).toBeNull();

    const adapter = new FakeAdapter();
    const { spawned } = await spawnAndAssign(employee, adapter);

    expect(adapter.startedContext).not.toBeNull();
    // The shipped developer role declares [balanced, capable].
    expect(adapter.startedContext!.modelId).toBe(SHIPPING_MODEL_TIERS['claude-code']!.balanced);

    await spawned.supervisor.stop(0);
  });

  it('POINT 1b: employees.updateSettings sets the override tier, and it reaches the spawn', async () => {
    // This handler used to write `employees.model`, which nothing read —
    // the second visible symptom of the same finding. It sets a TIER now,
    // and this asserts the tier actually reaches the launch rather than
    // just landing in a column.
    const employee = hire();
    const result = await employeesHandlers['updateSettings']!(
      { id: employee.id, modelTierOverride: 'capable' },
      {
        db: h.db,
        activityLog: h.activityLog,
        dbPaths: getDbPaths(h.tmpDir, REAL_MIGRATIONS_DIR),
        pricing: REAL_PRICING,
        baseDir: h.baseDir,
        bundledPacksDir: path.resolve('packs'),
        appVersion: '0.0.1',
      } as HandlerContext,
    );
    expect((result as { ok: boolean }).ok, 'updateSettings should have succeeded').toBe(true);

    const updated = getEmployeeById(h.db, employee.id)!;
    expect(updated.model_tier_override).toBe('capable');

    const adapter = new FakeAdapter();
    const { spawned } = await spawnAndAssign(updated, adapter);

    expect(adapter.startedContext).not.toBeNull();
    expect(adapter.startedContext!.modelId).toBe(SHIPPING_MODEL_TIERS['claude-code']!.capable);

    await spawned.supervisor.stop(0);
  });

  it('POINT 1d: the override is a TIER, so a settings remap reaches an already-hired employee', async () => {
    // The reason the column stores a tier rather than a resolved id. An
    // id pinned at hire would ignore this remap entirely, which is one of
    // the three silent breakages migration 0008 names.
    const employee = hire('engineering:developer', { modelTier: 'fast' });

    setSetting(h.db, 'engines.modelTiers', {
      'claude-code': { fast: 'remapped-fast', balanced: 'b-id', capable: 'c-id' },
    });

    const adapter = new FakeAdapter();
    const { spawned } = await spawnAndAssign(employee, adapter);

    expect(adapter.startedContext).not.toBeNull();
    expect(adapter.startedContext!.modelId).toBe('remapped-fast');

    await spawned.supervisor.stop(0);
  });

  it('POINT 1c: the tier→id map is settings-driven, not hardcoded', async () => {
    // The tier→id map itself comes from settings, not from a constant —
    // asserted separately from the override so a regression in either is
    // attributable to one of them.
    setSetting(h.db, 'engines.modelTiers', {
      'claude-code': { fast: 'f-id', balanced: 'b-id', capable: 'c-id' },
    });
    const employee = hire();
    const adapter = new FakeAdapter();

    const { spawned } = await spawnAndAssign(employee, adapter);

    expect(adapter.startedContext).not.toBeNull();
    // The shipped developer role declares [balanced, capable].
    expect(adapter.startedContext!.modelId).toBe('b-id');

    await spawned.supervisor.stop(0);
  });

  // --- JOIN POINT 2: does the hired employee's memory scope resolve? -----

  it('POINT 2: the memory hiring created is real and findable through the real search path', async () => {
    const employee = hire();

    const notes = path.join(getMemoryDir(h.baseDir), 'employee', employee.id, 'notes.md');
    expect(existsSync(notes), 'hire should have created employee memory').toBe(true);

    const hits = searchMemory(h.db, employee.name, { scopes: ['employee'], scopeRef: employee.id });
    expect(hits).toHaveLength(1);
  });

  it('POINT 2b: that memory now reaches the spawn — the M10 seam is wired, and the assertion is inverted', async () => {
    // **This test used to assert the opposite**, and the change is the
    // point. Its old name was "nothing injects that memory into the spawn —
    // memoryPack is an M10 seam, not a wired path", and it pinned an absence
    // so that the seam could not quietly close without somebody noticing.
    // M10 closed it deliberately, so the assertion flips rather than being
    // deleted: the join it guards is still the join, and an absence test
    // left behind after the absence ends is how a suite starts lying.
    //
    // Note what makes this a JOIN test rather than a memory test: hiring
    // (M7) wrote the note, and assignment (M10) is what reads it. Neither
    // half is exercised here on its own.
    const employee = hire();
    const adapter = new FakeAdapter();
    const project = insertProject(h.db, { name: 'boundary', path: h.tmpDir, kind: 'software' });
    const task = insertTask(h.db, {
      project_id: project.id,
      title: 'write the thing',
      body: 'Do the work.',
      acceptance_criteria: ['it works'],
      status: 'assigned',
    });
    // Pinned, because §12.3's pack takes pinned company standards
    // unconditionally — a keyword match would prove the search, not the
    // injection.
    writeMemory(h.db, {
      baseDir: h.baseDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Standards',
      body: '# Standards\n\nAlways run the tests before saying you are done.',
      source: 'user_stated',
      pinned: true,
    });

    const { spawned } = await spawnAndAssign(employee, adapter, task.id);

    // The adapter genuinely received it — not "an event says we would have".
    const sent = adapter.sentMessages.map((entry) => entry.text).join('\n');
    expect(sent).toContain('Always run the tests before saying you are done.');
    expect(sent).toContain('Do the work.');

    await spawned.supervisor.stop(0);
  });

  // --- JOIN POINT 3: do desk and sprite survive? ------------------------

  it('POINT 3: desk coordinates and sprite variant survive the spawn intact', async () => {
    // Set at hire and never read since. They reach the adapter as part of
    // `ctx.employee`; nothing consumes them until M12 renders a floor,
    // which is why this asserts survival rather than use.
    const employee = hire();
    expect(employee.sprite_variant).toMatch(/^dev_\d$/);

    const adapter = new FakeAdapter();
    const { spawned } = await spawnAndAssign(employee, adapter);

    expect(adapter.startedContext).not.toBeNull();
    const seen = adapter.startedContext!.employee;
    expect({ x: seen.desk_x, y: seen.desk_y }).toEqual({ x: employee.desk_x, y: employee.desk_y });
    expect(seen.sprite_variant).toBe(employee.sprite_variant);

    await spawned.supervisor.stop(0);
  });

  // --- JOIN POINT 5: the probe cache on the real spawn path -------------

  it('POINT 5: two hired employees on different adapters each get their own probe result', async () => {
    // The `adapter.key` leak was found late and fixed against unit tests.
    // This exercises it where it actually lives: two REAL hires, two real
    // spawns, two adapters that report different things — which is what
    // two employees pointed at different CLI config dirs would do.
    class TaggedAdapter extends FakeAdapter {
      constructor(private readonly tag: string) {
        super();
      }
      override async probe(): Promise<ProbeResult> {
        return {
          ...(await super.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS })),
          version: this.tag,
        };
      }
    }

    const cache = new ProbeCache();
    const a = hire('engineering:developer');
    const b = hire('engineering:tester');
    const adapterA = new TaggedAdapter('version-A');
    const adapterB = new TaggedAdapter('version-B');

    const spawnA = await spawnAndAssign(a, adapterA, null, cache);
    const spawnB = await spawnAndAssign(b, adapterB, null, cache);

    // Presence first: both must actually have probed.
    expect(spawnA.spawned.supervisor.getProbeResult()).not.toBeNull();
    expect(spawnB.spawned.supervisor.getProbeResult()).not.toBeNull();
    expect(spawnA.spawned.supervisor.getProbeResult()!.version).toBe('version-A');
    expect(spawnB.spawned.supervisor.getProbeResult()!.version).toBe('version-B');

    await spawnA.spawned.supervisor.stop(0);
    await spawnB.spawned.supervisor.stop(0);
  });

  it('POINT 5b: two hires sharing one adapter share one probe — the caching still works', async () => {
    // The other half, and the reason the cache exists at all: identity
    // keying must not have quietly disabled the collapsing it was built
    // for. Without this, POINT 5 alone would pass on a cache that never
    // caches anything.
    class CountingAdapter extends FakeAdapter {
      probeCalls = 0;
      override async probe(): Promise<ProbeResult> {
        this.probeCalls += 1;
        return super.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });
      }
    }

    const cache = new ProbeCache();
    const adapter = new CountingAdapter();
    const a = hire('engineering:developer');
    const b = hire('engineering:tester');

    const spawnA = await spawnAndAssign(a, adapter, null, cache);
    const spawnB = await spawnAndAssign(b, adapter, null, cache);

    expect(adapter.probeCalls, 'two employees on one adapter should cost one probe').toBe(1);

    await spawnA.spawned.supervisor.stop(0);
    await spawnB.spawned.supervisor.stop(0);
  });

  // --- the join as a whole ---------------------------------------------

  it('the full M7→M4 chain leaves consistent state across both construction paths', async () => {
    const employee = hire();
    const project = insertProject(h.db, { name: 'chain', path: h.tmpDir, kind: 'software' });
    const task = insertTask(h.db, {
      project_id: project.id,
      title: 'chain task',
      body: 'Do the thing.',
      acceptance_criteria: ['it ran'],
    });
    const adapter = new FakeAdapter();

    const { spawned } = await spawnAndAssign(employee, adapter, task.id);

    // M7's row, M4's token, M3's supervisor — all agreeing on one id.
    const row = getEmployeeById(h.db, employee.id)!;
    expect(row.id).toBe(employee.id);
    expect(h.supervisorRegistry.get(employee.id)).toBe(spawned.supervisor);
    expect(h.tokenRegistry.verify(spawned.token)).toBe(employee.id);

    // And the hire's own event is still the only one for this employee —
    // spawning did not emit a second "hired".
    const hired = h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE type = 'company.employee_hired' AND employee_id = ?",
      )
      .get(employee.id);
    expect(hired).toEqual({ n: 1 });

    await spawned.supervisor.stop(0);
  });
});
