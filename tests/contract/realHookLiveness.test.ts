import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { ActivityLog } from '../../src/main/db/activityLog';
import { ControlChannelServer } from '../../src/main/controlChannel/server';
import { TokenRegistry } from '../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../src/main/engine/supervisorRegistry';
import {
  spawnSupervisedEmployee,
  buildControlChannelAndToolServerContext,
} from '../../src/main/engine/spawnSupervisedEmployee';
import {
  createRealClaudeCodeAdapterForTests,
  resolveBureauToolsScriptPathForTests,
} from '../helpers/realEngineAdapter';
import { buildResolvedPath, resolveBinaryAbsolutePath } from '../../src/main/engine/resolvedPath';
import { insertRole } from '../../src/main/db/repositories/roles';
import { insertEmployee, getEmployeeById } from '../../src/main/db/repositories/employees';
import { seedSettingsDefaults } from '../../src/main/db/settingsLoader';
import { storeSecret, type SafeStorageLike } from '../../src/main/secrets/secretStore';
import {
  ANTHROPIC_API_KEY_SETTING,
  createRealSecretBroker,
} from '../../src/main/secrets/secretBroker';
import { SecretRegistry } from '../../src/main/secrets/redactor';
import { applyRealRunBudgets } from '../helpers/realRunBudgets';
import { newId, nowIso } from '../../src/shared/models/ids';

/**
 * **Does the pinned CLI really run Bureau's `SessionStart` hook?** (M11 hook
 * liveness, §7.6.)
 *
 * `Supervisor.assign()` now refuses any claude-code employee whose
 * `SessionStart` hook never reports to the control channel. The free test
 * (`hookLiveness.test.ts`) proves the mechanism with a scripted stand-in for
 * the CLI. This proves the premise it rests on: that the real CLI, launched
 * with the real adapter's settings file and the handshake's environment
 * (no key, an unreachable API address), still fires that hook — through the
 * whole production chain, `assign()` included. If it does not, every real
 * start is refused, which is safe and would be noticed at once, but this is
 * where it should be noticed. It also logs how long the handshake takes,
 * because every start now waits for it.
 *
 * **It cannot spend money, three times over.** The handshake is given no
 * key; its API address is a closed loopback port; and the one key stored
 * (which `assign()` requires, E-4a) is deliberately invalid. The handshake
 * is the only launch, because the employee has no task. Opt-in all the
 * same, because it needs the real CLI.
 */
const resolvedPathForRealClaude = await buildResolvedPath();
const realClaudePath = resolveBinaryAbsolutePath('claude', resolvedPathForRealClaude);
const explicitlyOptedIn = process.env.BUREAU_RUN_REAL_ENGINE_TESTS === '1';
const shouldRun = realClaudePath !== null && explicitlyOptedIn;

function skipReason(): string {
  if (!realClaudePath) return 'claude CLI not found via the resolved-PATH service on this machine';
  return 'BUREAU_RUN_REAL_ENGINE_TESTS is not set — real-engine tests are opt-in, not automatic';
}

if (!shouldRun) {
  console.log(`[realHookLiveness.test.ts] skipping: ${skipReason()}`);
}

/** A reversible stand-in for DPAPI, which cannot run in plain Node. */
const testSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
};

describe('the pinned CLI runs the SessionStart liveness hook', () => {
  it.skipIf(!shouldRun)(
    'a real claude-code employee starts, and the start names the session its hook reported',
    async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-real-liveness-'));
      let db: Database.Database | undefined;
      let activityLog: ActivityLog | undefined;
      let server: ControlChannelServer | undefined;
      const supervisorRegistry = new SupervisorRegistry();
      try {
        const dbPath = path.join(tmpDir, 'bureau.db');
        db = openConnection(dbPath);
        await runMigrations({
          db,
          dbPath,
          migrationsDir: path.resolve('src/main/db/migrations'),
          backupsDir: path.join(tmpDir, 'backups'),
        });
        activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
        seedSettingsDefaults(db);
        applyRealRunBudgets(db);
        const stored = await storeSecret(
          db,
          ANTHROPIC_API_KEY_SETTING,
          'sk-ant-api03-deliberately-invalid-bureau-liveness-check',
          'anthropic',
          testSafeStorage,
        );
        expect(stored.stored).toBe(true);
        const broker = createRealSecretBroker(db, new SecretRegistry(), testSafeStorage);
        const now = nowIso();
        db.prepare(
          'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
        ).run('dept1', 'engineering', 'Engineering', '{}', now, now);

        const tokenRegistry = new TokenRegistry();
        server = new ControlChannelServer({ db, activityLog, tokenRegistry, supervisorRegistry });
        const port = await server.start();

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
          name: `liveness-${newId()}`,
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
          adapter: createRealClaudeCodeAdapterForTests(db),
          baseDir: tmpDir,
        });
        const assignStartedAt = Date.now();
        await spawned.supervisor.assign({
          employee: getEmployeeById(db, employee.id)!,
          role,
          task: null,
          worktreePath: '',
          stateDir: spawned.stateDir,
          baseDir: tmpDir,
          broker,
          modelId: null,
          turnBudgetCapUsdMicros: null,
          ...buildControlChannelAndToolServerContext(spawned, resolveBureauToolsScriptPathForTests),
        });

        const started = db
          .prepare("SELECT payload FROM events WHERE type = 'employee.started' AND employee_id = ?")
          .get(employee.id) as { payload: string } | undefined;
        const hookSessionId = started
          ? (JSON.parse(started.payload) as { hookSessionId?: unknown }).hookSessionId
          : undefined;
        console.log(
          `[hook liveness, real CLI] hook reported session: ${String(hookSessionId)}; assign took ${Date.now() - assignStartedAt} ms`,
        );
        const usage = db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number };
        console.log(`[real-run cost] realHookLiveness: $0 by construction; usage rows ${usage.n}`);
        expect(typeof hookSessionId).toBe('string');
        expect(usage.n, 'the handshake made no billed call').toBe(0);
      } finally {
        for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
        await server?.stop();
        activityLog?.close();
        db?.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  if (!shouldRun) {
    it.skip(`(the real liveness check is skipped: ${skipReason()})`, () => {});
  }
});
