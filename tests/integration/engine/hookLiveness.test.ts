import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { ProbeCache } from '../../../src/main/engine/probeCache';
import { createClaudeCodeAdapterFromSettings } from '../../../src/main/engine/claudeCodeAdapter';
import {
  spawnSupervisedEmployee,
  buildControlChannelAndToolServerContext,
} from '../../../src/main/engine/spawnSupervisedEmployee';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee, getEmployeeById } from '../../../src/main/db/repositories/employees';
import { EngineHookNotRunningError } from '../../../src/shared/engine/types';
import { UserFacingError } from '../../../src/shared/errors/userFacing';
import type { SecretBroker } from '../../../src/shared/engine/seams';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { storeTestAnthropicKey } from '../../helpers/storedAnthropicKey';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';

/**
 * **The Core confirms the policy hook actually ran**, rather than trusting
 * that it was registered.
 *
 * The PreToolUse hook is the policy gate for an employee (§11.3). Measured on
 * the pinned CLI (`realBareMode.test.ts`): under `--bare` no hook runs at
 * all, yet a `bureau_` tool call still reaches the Core and changes its
 * state. Bureau never passes `--bare`, but the CLI is making it the default
 * for `-p`, and then not passing it protects nothing. So `assign()` asks the
 * CLI to prove it runs Bureau's hooks: a handshake launch whose
 * `SessionStart` hook reports to the control channel with the employee's
 * own token. No report, no employee.
 *
 * **The handshake must not be able to spend.** Measured on the pinned CLI:
 * `--max-turns 0` still reaches the model step. So the handshake is given
 * no credentials at all — the broker is never asked — and an API address
 * nothing listens on. The first test asserts exactly that, with a broker
 * that does hold a key.
 *
 * Driven through the real chain: the adapter built by
 * `createClaudeCodeAdapterFromSettings`, its real launch spec and settings
 * file, the real bundled `bureau-hook.js`, the real control channel and the
 * real Supervisor. **The one stand-in is the CLI** (`fakeClaudeCli.cjs`,
 * spawned through the adapter's `spawnProcess` seam): it reads the settings
 * file the adapter wrote and runs the `SessionStart` hooks it names, as the
 * real CLI does — or, to play a CLI that ignores hooks, runs none.
 */
const FAKE_CLI = path.resolve('tests/helpers/fakeClaudeCli.cjs');
const HOOK_SCRIPT = path.resolve('dist/resources/bin/bureau-hook.js');
const KEY_THE_HANDSHAKE_MUST_NOT_GET = 'sk-ant-handshake-must-never-see-this';

/** A broker that would hand out a key, as the real one does once a key is
 *  stored — so its absence from the handshake is a decision, not an accident. */
const brokerHoldingAKey: SecretBroker = {
  async resolveForSpawn() {
    return {
      env: { ANTHROPIC_API_KEY: KEY_THE_HANDSHAKE_MUST_NOT_GET },
      secretValues: [KEY_THE_HANDSHAKE_MUST_NOT_GET],
    };
  },
  async revokeForEmployee() {},
};

describe('hook liveness: no employee starts unless its hook reached the Core', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let server: ControlChannelServer;
  let tokenRegistry: TokenRegistry;
  let supervisorRegistry: SupervisorRegistry;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-hook-liveness-'));
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
    await storeTestAnthropicKey(db);
    const now = nowIso();
    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', '{}', now, now);
    tokenRegistry = new TokenRegistry();
    supervisorRegistry = new SupervisorRegistry();
    server = new ControlChannelServer({ db, activityLog, tokenRegistry, supervisorRegistry });
    port = await server.start();
  });

  afterEach(async () => {
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  type CliBehaviour = 'runs_hooks' | 'ignores_hooks' | 'hook_config_removed';

  /** Starts one employee against a CLI that behaves as told, and reports
   *  what the Supervisor decided plus every argv the CLI was launched with. */
  async function launch(behaviour: CliBehaviour) {
    expect(existsSync(HOOK_SCRIPT), 'run `npm run build` first: the real hook script').toBe(true);
    const argvLog = path.join(tmpDir, `argv-${newId()}.log`);
    const launchEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const spawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => {
      launchEnvs.push(options.env);
      if (behaviour === 'hook_config_removed') {
        const settingsPath = args[args.indexOf('--settings') + 1]!;
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        delete settings.hooks.SessionStart;
        writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');
      }
      void command;
      return spawn(process.execPath, [FAKE_CLI, ...args], {
        ...options,
        env: {
          ...options.env,
          FAKE_CLAUDE_ARGV_LOG: argvLog,
          ...(behaviour === 'ignores_hooks' ? { FAKE_CLAUDE_IGNORE_HOOKS: '1' } : {}),
        },
      });
    };
    const adapter = createClaudeCodeAdapterFromSettings(db, {
      resolveBureauHookScriptPath: () => HOOK_SCRIPT,
      resolveBinary: async () => ({ resolvedPathString: '', binaryPath: process.execPath }),
      runVersionCheck: async () => '2.1.276 (Claude Code)',
      spawnProcess,
    });

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
    const spawned = await spawnSupervisedEmployee({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      controlChannelPort: port,
      employeeId: employee.id,
      adapter,
      baseDir: tmpDir,
      supervisorOptions: { probeCache: new ProbeCache(), heartbeatCheckIntervalMs: 999_999_999 },
    });

    let refusal: unknown = null;
    try {
      await spawned.supervisor.assign({
        employee: getEmployeeById(db, employee.id)!,
        role,
        task: null,
        worktreePath: '',
        stateDir: spawned.stateDir,
        baseDir: tmpDir,
        broker: brokerHoldingAKey,
        modelId: null,
        turnBudgetCapUsdMicros: null,
        ...buildControlChannelAndToolServerContext(spawned, resolveBureauToolsScriptPathForTests),
      });
    } catch (err) {
      refusal = err;
    }
    const launches = existsSync(argvLog)
      ? readFileSync(argvLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[])
      : [];
    const eventTypes = (
      db
        .prepare('SELECT type FROM events WHERE employee_id = ? ORDER BY seq')
        .all(employee.id) as Array<{ type: string }>
    ).map((row) => row.type);
    return {
      refusal,
      launches,
      launchEnvs,
      eventTypes,
      supervisor: spawned.supervisor,
      employeeId: employee.id,
    };
  }

  it('a CLI that runs the hook passes, and the start records the session the hook reported', async () => {
    const result = await launch('runs_hooks');

    expect(result.refusal).toBeNull();
    expect(result.supervisor.currentState).not.toBe('failed');
    const started = db
      .prepare("SELECT payload FROM events WHERE type = 'employee.started' AND employee_id = ?")
      .get(result.employeeId) as { payload: string } | undefined;
    expect(started, 'the employee started').toBeDefined();
    const payload = JSON.parse(started!.payload) as { hookSessionId?: unknown };
    expect(typeof payload.hookSessionId, 'the start names the session the hook reported').toBe(
      'string',
    );
    // One launch, the handshake: the turn's own settings file, bounded to
    // one turn, and unable to reach a model — no key, and an API address on
    // a closed loopback port — even though the broker holds a key.
    expect(result.launches).toHaveLength(1);
    const handshake = result.launches[0]!;
    expect(handshake[handshake.indexOf('--max-turns') + 1]).toBe('1');
    expect(handshake).toContain('--settings');
    const env = result.launchEnvs[0]!;
    expect(env['ANTHROPIC_API_KEY'], 'the handshake was handed a key').toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(KEY_THE_HANDSHAKE_MUST_NOT_GET);
    expect(env['ANTHROPIC_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 30_000);

  it.each<CliBehaviour>(['ignores_hooks', 'hook_config_removed'])(
    'a CLI that never runs the hook (%s) is refused before any turn, in plain words',
    async (behaviour) => {
      const result = await launch(behaviour);

      expect(result.refusal).toBeInstanceOf(EngineHookNotRunningError);
      expect(result.refusal).toBeInstanceOf(UserFacingError);
      // Refused before `starting`: no state change, no start, no turn.
      expect(getEmployeeById(db, result.employeeId)?.status).toBe('off');
      expect(result.eventTypes).not.toContain('employee.started');
      expect(result.eventTypes).not.toContain('employee.starting');
      expect(result.eventTypes).not.toContain('tool.requested');
      // Exactly one launch — the handshake — and nothing after it.
      expect(result.launches).toHaveLength(1);
      expect(result.launches[0]).toContain('--max-turns');
    },
    30_000,
  );
});
