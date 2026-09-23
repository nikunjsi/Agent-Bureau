import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { EngineApiKeyRequiredError } from '../../../src/shared/engine/types';
import { UserFacingError } from '../../../src/shared/errors/userFacing';
import { storeSecret, type SafeStorageLike } from '../../../src/main/secrets/secretStore';
import { isAnthropicApiKeyStored } from '../../../src/main/secrets/anthropicKeyPresence';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee } from '../../../src/main/db/repositories/employees';
import { newId, nowIso } from '../../../src/shared/models/ids';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';
import type { EngineAdapter } from '../../../src/shared/engine/adapter';

/**
 * Two findings from the `--bare` measurement, kept honest for free.
 *
 * **1. `--bare` is never passed.** Measured on the pinned CLI
 * (`tests/contract/realBareMode.test.ts`, opt-in): under `--bare` the MCP
 * server still loads and a `bureau_` tool call still reaches the Core, but
 * the PreToolUse hook **does not run at all** — no `tool.requested`, no
 * verdict, no gate. Bureau's whole policy layer for an employee is that
 * hook (§11.3), so a session launched with `--bare` is an ungoverned
 * session, and invariant #6 leaves one option: never pass it. This is the
 * guard that keeps a later edit from adding it back quietly.
 *
 * **2. A real claude-code launch needs a stored API key.** Risk #34's
 * decision E-4a: Bureau-driven runs use an API key, and the subscription
 * is for small manual checks only. With no key the CLI silently falls back
 * to whatever subscription login its config directory resolves — on the
 * user's own account — so `assign()` refuses first, naming the field.
 */
describe('what the --bare measurement decided, guarded for free', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-bare-guard-'));
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

  const testSafeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
    decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
  };

  /**
   * A FakeAdapter that answers `claude-code` to `key`, which is what the
   * refusal is keyed on: the question the guard asks is whether the thing
   * about to run will really launch the CLI. Built by delegation rather
   * than by subclassing, because `FakeAdapter.key` is narrowed to its own
   * literal — everything else here is the real FakeAdapter's, and it still
   * spawns nothing, so no test in this file can reach a real engine.
   */
  function claudeCodeShaped(): EngineAdapter {
    const inner = new FakeAdapter({ keepOpen: true });
    return Object.create(inner, {
      key: { value: 'claude-code', enumerable: true },
    }) as EngineAdapter;
  }

  function makeContext(): EmployeeContext {
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
    return {
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
  }

  it('the launch spec and the turn argv never contain --bare', async () => {
    const adapter = new ClaudeCodeAdapter({
      resolveBinary: async () => ({
        resolvedPathString: 'C:\\fake',
        binaryPath: 'C:\\fake\\claude.exe',
      }),
      resolveBureauHookScriptPath: () => path.resolve('dist/resources/bin/bureau-hook.js'),
    });
    const ctx = makeContext();

    const spec = await adapter.buildLaunchSpec(ctx);
    const turnArgs = adapter.buildTurnArgs('do the thing', spec);

    expect(spec.args).not.toContain('--bare');
    expect(turnArgs).not.toContain('--bare');
    // Nor smuggled in through the environment the child inherits.
    expect(Object.keys(spec.env)).not.toContain('CLAUDE_CODE_SIMPLE');
  });

  it('assign() refuses a real claude-code launch with no stored key, and names the field', async () => {
    const ctx = makeContext();
    const supervisor = new Supervisor(ctx.employee.id, {
      db,
      activityLog,
      adapter: claudeCodeShaped(),
    });

    expect(isAnthropicApiKeyStored(db)).toBe(false);
    await expect(supervisor.assign(ctx)).rejects.toThrow(EngineApiKeyRequiredError);
    await expect(supervisor.assign(ctx)).rejects.toThrow(UserFacingError);
    await expect(supervisor.assign(ctx)).rejects.toThrow(/Anthropic API key/i);
    await expect(supervisor.assign(ctx)).rejects.toThrow(/Settings/i);
    // Refused before anything started: no state change, so no event either.
    expect(supervisor.currentState).toBe('off');
  });

  it('assign() proceeds once a key is stored', async () => {
    await storeSecret(db, 'anthropic_api_key', 'sk-ant-stored', 'anthropic', testSafeStorage);
    expect(isAnthropicApiKeyStored(db)).toBe(true);
    const ctx = makeContext();
    const supervisor = new Supervisor(ctx.employee.id, {
      db,
      activityLog,
      adapter: claudeCodeShaped(),
    });

    await supervisor.assign(ctx);

    expect(supervisor.currentState).not.toBe('off');
    await supervisor.stop();
  });

  it('an adapter that will not launch the CLI is unaffected — the rule is the real engine’s', async () => {
    const ctx = makeContext();
    const supervisor = new Supervisor(ctx.employee.id, {
      db,
      activityLog,
      adapter: new FakeAdapter({ keepOpen: true }),
    });

    // Same employee row, same missing key: what differs is that nothing is
    // about to launch a real CLI, so there is no subscription to fall back
    // onto and nothing to refuse.
    await supervisor.assign(ctx);

    expect(supervisor.currentState).not.toBe('off');
    await supervisor.stop();
  });
});
