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
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { TESTED_ENGINE_VERSIONS } from '../../../src/main/engine/engineVersionDrift';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';
import type { EngineAdapter } from '../../../src/shared/engine/adapter';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §7.8 test 10 / §27 risk 15, AUDIT #6 — the EMISSION half.
 *
 * The contract test covers the detector; this covers a real `Supervisor`
 * actually emitting `employee.engine_version_drift` from a real probe
 * result, asserted against the real `events` table. Before this, the
 * event type existed in §5.2's taxonomy and was emitted by nothing.
 *
 * Still honestly uncovered: the "untested version" badge (§7.8 test 10's
 * second clause) — there is no UI to show it in until M9/M13.
 */
describe('employee.engine_version_drift is emitted by a real Supervisor (AUDIT #6)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-drift-'));
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

  /**
   * The drift check pairs the adapter's own key with the version its own
   * probe reported, so both must be real inputs. `FakeAdapter.key` is the
   * literal type `'fake'` and cannot be widened, so this delegates to a
   * real FakeAdapter and overrides only those two — rather than loosening
   * a production type for a test's convenience.
   */
  function versionedAdapter(key: string, reportedVersion: string | null): EngineAdapter {
    const inner = new FakeAdapter({ events: [] });
    return {
      key,
      supportedModes: inner.supportedModes,
      probe: async () => ({ ...(await inner.probe()), version: reportedVersion }),
      capabilities: (probeResult, mode) => inner.capabilities(probeResult, mode),
      buildLaunchSpec: (c) => inner.buildLaunchSpec(c),
      start: (c) => inner.start(c),
      send: (text, kind) => inner.send(text, kind),
      events: () => inner.events(),
      applyVerdict: (callId, verdict) => inner.applyVerdict(callId, verdict),
      interrupt: () => inner.interrupt(),
      stop: (graceMs) => inner.stop(graceMs),
      resume: (sessionId, c) => inner.resume(sessionId, c),
      lastActivityAt: () => inner.lastActivityAt(),
    };
  }

  function seedAndAssign(adapter: EngineAdapter): Promise<void> {
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
    } as never);
    const employee = insertEmployee(db, {
      name: `Ravi-${newId()}`,
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'off',
      engine: 'claude-code',
      autonomy: 'guided',
    } as never);
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
      effectiveAutonomy: 'ask',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });
    return supervisor.assign(ctx).then(() => supervisor.stop());
  }

  function driftEvents(): Array<{ payload: string | null }> {
    return db
      .prepare("SELECT payload FROM events WHERE type = 'employee.engine_version_drift'")
      .all() as Array<{ payload: string | null }>;
  }

  it('emits the event when the real probe reports a version outside the tested pin', async () => {
    await seedAndAssign(versionedAdapter('claude-code', '99.0.1'));

    const events = driftEvents();
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload ?? '{}') as {
      reportedVersion: string;
      testedVersions: string[];
    };
    expect(payload.reportedVersion).toBe('99.0.1');
    expect(payload.testedVersions).toEqual([...(TESTED_ENGINE_VERSIONS['claude-code'] ?? [])]);
  });

  it('stays silent for the exact tested version — the signal means something', async () => {
    const tested = TESTED_ENGINE_VERSIONS['claude-code']![0]!;
    await seedAndAssign(versionedAdapter('claude-code', tested));
    expect(driftEvents()).toEqual([]);
  });

  it('stays silent for an engine with no tested pin, and for a probe that reports no version at all', async () => {
    await seedAndAssign(versionedAdapter('generic-pty', '9.9.9'));
    expect(driftEvents()).toEqual([]);

    await seedAndAssign(versionedAdapter('claude-code', null));
    expect(driftEvents()).toEqual([]);
  });
});
