import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee } from '../../../src/main/db/repositories/employees';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { CLAUDE_CODE_DEFAULT_MODEL_TIERS } from '../../../src/main/engine/modelTiers';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * AUDIT #1, the CHAIN half. The pure resolver is covered by
 * `tests/unit/engine/modelTierResolution.test.ts`; this file proves the
 * real `Supervisor.assign()` actually walks
 * `role.model_preference` -> `settings.engines.modelTiers` -> a concrete id
 * and hands it to the adapter on the real `EmployeeContext` — against a
 * real migrated DB with real settings rows, not a hand-built map.
 *
 * The audit's own lesson (findings #2/#3/#4) is that a test which
 * re-implements the wiring it claims to check proves nothing, so nothing
 * here recomputes the resolution: it reads what the adapter was actually
 * handed.
 */
describe('Supervisor model-tier resolution (§7.5) — the real role -> settings -> adapter chain', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-modeltier-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
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

  function seed(roleOverrides: Record<string, unknown>) {
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
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: [],
      autonomy_default: 'guided',
      sprite_key: 'dev',
      ...roleOverrides,
    } as never);
    const employee = insertEmployee(db, {
      name: `Quinn-${newId()}`,
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'off',
      engine: 'claude-code',
      autonomy: 'guided',
    } as never);
    return { role, employee };
  }

  function ctxFor(role: unknown, employee: unknown): EmployeeContext {
    return {
      employee: employee as EmployeeContext['employee'],
      role: role as EmployeeContext['role'],
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
  }

  /** Runs a real assign() and returns the context the adapter was actually
   *  handed — read back off the adapter, never recomputed here. */
  async function assignAndCaptureContext(
    role: unknown,
    employee: { id: string },
  ): Promise<EmployeeContext> {
    const adapter = new FakeAdapter({
      events: [{ t: 'session.started', sessionId: 's1', engineVersion: 'x', model: null }],
    });
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    await supervisor.assign(ctxFor(role, employee));
    await supervisor.stop();
    const seen = adapter.startedContext;
    if (!seen) throw new Error('adapter.start() never received a context');
    return seen;
  }

  it('resolves a role’s declared `capable` tier through a real settings row to that tier’s configured id', async () => {
    setSetting(db, 'engines.modelTiers', {
      'claude-code': { capable: 'configured-capable-model' },
    });
    const { role, employee } = seed({ model_preference: ['capable'] });

    const seen = await assignAndCaptureContext(role, employee);

    expect(seen.modelId).toBe('configured-capable-model');
  });

  it('a `capable` role and a `fast` role get DIFFERENT models — the regression this finding is about', async () => {
    setSetting(db, 'engines.modelTiers', {
      'claude-code': { fast: 'the-fast-one', capable: 'the-capable-one' },
    });
    const capableRole = seed({ model_preference: ['capable'] });
    const fastRole = seed({ model_preference: ['fast'] });

    const capableCtx = await assignAndCaptureContext(capableRole.role, capableRole.employee);
    const fastCtx = await assignAndCaptureContext(fastRole.role, fastRole.employee);

    expect(capableCtx.modelId).toBe('the-capable-one');
    expect(fastCtx.modelId).toBe('the-fast-one');
    // Before AUDIT #1 both of these were the `fast` shipping id, always.
    expect(capableCtx.modelId).not.toBe(fastCtx.modelId);
  });

  it('falls back to the shipping default when no settings mapping is configured — still tier-correct, not always `fast`', async () => {
    const { role, employee } = seed({ model_preference: ['capable'] });

    const seen = await assignAndCaptureContext(role, employee);

    expect(seen.modelId).toBe(CLAUDE_CODE_DEFAULT_MODEL_TIERS.capable);
    expect(seen.modelId).not.toBe(CLAUDE_CODE_DEFAULT_MODEL_TIERS.fast);
  });

  it('derives the per-turn spend ceiling from the real task budget, not a hardcoded 5¢', async () => {
    // §11.5: 2_000_000 micros = $2.00, the shipped `budgets.perTaskUsd`
    // default. The old hardcoded cap was $0.05 — 40x smaller, which meant
    // no §11.5 level could ever bind first.
    const { role, employee } = seed({
      model_preference: ['balanced'],
      budget_usd_micros: 3_000_000,
    });

    const seen = await assignAndCaptureContext(role, employee);

    expect(seen.turnBudgetCapUsdMicros).toBe(3_000_000);
    expect(seen.turnBudgetCapUsdMicros).not.toBe(50_000); // the old hardcoded $0.05
  });

  it('uses the `budgets.perTaskUsd` setting when the role declares no budget of its own', async () => {
    setSetting(db, 'budgets.perTaskUsd', 7.5); // stored as micros by the settings layer
    const { role, employee } = seed({ model_preference: ['balanced'] });

    const seen = await assignAndCaptureContext(role, employee);

    expect(seen.turnBudgetCapUsdMicros).toBe(7_500_000);
  });
});
