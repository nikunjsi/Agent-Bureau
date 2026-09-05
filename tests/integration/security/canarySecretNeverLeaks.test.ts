import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { getDbPaths } from '../../../src/main/db/paths';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { seedProject, seedEmployee, seedTask } from '../../helpers/dbFixtures';
import {
  registerProjectWorkspace,
  hireEmployeeWorktree,
  assignTaskToWorktree,
  resolveDefaultIntegrationRef,
} from '../../../src/main/workspace/employeeWorktree';
import { commitTaskWork } from '../../../src/main/workspace/employeeCommit';
import { getCheckedOutBranch } from '../../../src/main/workspace/gitWorktree';
import { completeTask, getTaskById } from '../../../src/main/db/repositories/tasks';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import { Supervisor, createFileTranscriptWriter } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { storeSecret, type SafeStorageLike } from '../../../src/main/secrets/secretStore';
import { createRealSecretBroker } from '../../../src/main/secrets/secretBroker';
import { globalSecretRegistry } from '../../../src/main/secrets/redactor';
import { pushPatch, wireStateDeltaOnLoad } from '../../../src/main/ipc/stateDelta';
import { buildSupportBundle } from '../../../src/main/ipc/handlers/system';
import { newId } from '../../../src/shared/models/ids';
import { getRoleByFullKey } from '../../../src/main/db/repositories/roles';
import { placeholderToolServer, placeholderControlChannel, type SecretBroker } from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { PricingTable } from '../../../src/shared/models/pricing';
import type { Validator } from '../../../src/main/workspace/validators';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const TRIVIAL_VALIDATORS: Validator[] = [
  { name: 'secret-scan', run: async () => ({ name: 'secret-scan', passed: true, output: 'no secrets detected' }) },
];
const FAKE_PRICING: PricingTable = { version: 1, verified_at: '2026-01-01', verified_against: 'test', engines: {} };

function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`FAKE-ENCRYPTED:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace(/^FAKE-ENCRYPTED:/, ''),
  };
}

/**
 * `FakeAdapter.key` is genuinely `'fake'` — it is not standing in for
 * `'claude-code'` anywhere else in this codebase, and `secretBroker.
 * test.ts`'s own "never resolves anything for an engine other than
 * claude-code" case proves that gate is real, load-bearing production
 * behaviour, not an accident. This is this TEST's own fixture: it stands
 * in for what a real `ClaudeCodeAdapter`'s own `this.key` would already
 * pass to `resolveForSpawn`, so a Supervisor driven by `FakeAdapter` can
 * still exercise the real store→broker→env chain end to end. It does not
 * touch or weaken the real broker's own gate.
 */
function bridgeBrokerToClaudeCode(real: SecretBroker): SecretBroker {
  return {
    resolveForSpawn: (ctx) => real.resolveForSpawn({ ...ctx, engineKey: 'claude-code' }),
    revokeForEmployee: (id) => real.revokeForEmployee(id),
  };
}

/**
 * §11.7 S4 (`canary_secret_never_leaks`) — the test that justifies the
 * single-choke-point redactor design (§11.4): if this needed six separate
 * scans tuned to six different mechanisms, the choke point wouldn't be
 * one. One canary, planted the same way a real API key would be (through
 * `secretStore.storeSecret`, resolved through the real `secretBroker`,
 * registered by that real resolve call — never written straight into the
 * registry, which would only prove the registry's own lookup works, not
 * the real store→broker→employee-env chain this test exists to prove).
 *
 * Uses `globalSecretRegistry`, not an isolated `new SecretRegistry()` —
 * unlike `redactor.test.ts`/`secretBroker.test.ts` (which test matching
 * logic in isolation and inject their own registry), the six real sinks
 * under test here (Supervisor's RedactionStream, ActivityLog, employeeCommit,
 * stateDelta, supportBundle) all default to the module-level
 * `globalSecretRegistry` internally, with no override seam — there is
 * nothing else this test could register the canary into that these real
 * call sites would ever see. `SecretRegistry` never unregisters by
 * design (an old secret must stay redactable in old logs), so the canary
 * value is a fresh, effectively-unique string per test run
 * (`newId()`-suffixed) — leaking into `globalSecretRegistry` for the rest
 * of the process is expected and harmless, not cleaned up.
 */
describe('S4: canary_secret_never_leaks (§11.7)', () => {
  let dbDir: string;
  let repoPath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;
  const CANARY = `BUREAU-CANARY-${newId()}`;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-s4-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-s4-repo-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-s4-home-'));
    const dbPath = path.join(dbDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(dbDir, 'backups') });
    activityLog = ActivityLog.open(path.join(dbDir, 'activity.jsonl'), db);
    ctx = { db, activityLog, dbPaths: getDbPaths(dbDir, REAL_MIGRATIONS_DIR), pricing: FAKE_PRICING };
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(companyHomePath, { recursive: true, force: true });
  });

  it('a canary planted through the real secret store reaches spawn env, then appears in NONE of six real outbound paths', async () => {
    // --- plant: the real store leg, not a shortcut into the registry ---
    await storeSecret(db, 'anthropic_api_key', CANARY, 'anthropic', fakeSafeStorage());
    const realBroker = createRealSecretBroker(db, globalSecretRegistry, fakeSafeStorage());
    const broker = bridgeBrokerToClaudeCode(realBroker);

    // --- real project/employee/worktree/task, same setup gitProtectionLayer4.test.ts (S6) uses ---
    const project = seedProject(db, { path: repoPath });
    await registerProjectWorkspace(db, project);
    const initialBranch = await getCheckedOutBranch(repoPath);
    db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(initialBranch, project.id);
    const registeredProject = getProjectById(db, project.id)!;
    const employee = seedEmployee(db, { name: 'Canary' });
    let worktree = await hireEmployeeWorktree({ db, activityLog, project: registeredProject, employee, companyHomePath });
    const task = seedTask(db, { project_id: registeredProject.id, title: 'Canary task', status: 'review' });
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project: registeredProject,
      employee,
      worktree,
      task,
      integrationRef: resolveDefaultIntegrationRef(registeredProject),
    });

    const employeeCtx: EmployeeContext = {
      employee,
      role: getRoleByFullKey(db, employee.role_key)!,
      task,
      worktreePath: worktree.path,
      stateDir: dbDir,
      memoryPack: '',
      decisionLog: '',
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker,
      effectiveAutonomy: 'ask',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };

    // --- drive a real Supervisor + FakeAdapter, canary in the raw stream ---
    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        { t: 'raw', data: Buffer.from(`using key ${CANARY} to authenticate\n`, 'utf8') },
        { t: 'idle' },
      ],
    });
    const supervisorRegistry = new SupervisorRegistry();
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter,
      supervisorRegistry,
      transcriptWriter: createFileTranscriptWriter(dbDir),
    });
    supervisorRegistry.register(employee.id, supervisor);
    await supervisor.assign(employeeCtx);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // ==================================================================
    // LEG 1 — PRESENCE, proven first (the kickoff's own explicit order):
    // the canary genuinely reached the employee's spawn environment via
    // the real store→broker chain, not a broker that silently no-op'd.
    // ==================================================================
    expect(adapter.resolvedSecretsAtSpawn?.env.ANTHROPIC_API_KEY).toBe(CANARY);
    expect(adapter.resolvedSecretsAtSpawn?.secretValues).toContain(CANARY);

    // ==================================================================
    // LEG 2 — ABSENCE, across six real outbound paths.
    // ==================================================================

    // (1+2) terminal stream + transcript — one RedactionStream instance,
    // two sinks (Supervisor.handleEvent's own `case 'raw':`); the
    // transcript file is the persisted, inspectable half of that pair.
    const transcriptPath = path.join(dbDir, 'employees', employee.id, 'transcript.log');
    expect(existsSync(transcriptPath)).toBe(true);
    const transcriptText = readFileSync(transcriptPath, 'utf8');
    expect(transcriptText).not.toContain(CANARY);
    expect(transcriptText).toContain('«redacted:secret»');

    // (3) event payloads — activity.jsonl, the raw file, not the DB mirror.
    const activityText = readFileSync(path.join(dbDir, 'activity.jsonl'), 'utf8');
    expect(activityText).not.toContain(CANARY);

    // (4) IPC to the renderer — driven through the REAL outbound path.
    //
    // AUDIT #3: this leg used to read
    //   JSON.stringify(redactDeep(buildFullSnapshot(db)))
    // — the test calling `redactDeep` itself. That proved `redactDeep`
    // works; it proved nothing about whether the production path calls
    // it, and deleting the call from `wireStateDeltaOnLoad` left S4
    // green. Now the real function runs and the assertion is made against
    // exactly the bytes it hands to `webContents.send`.
    //
    // Only the DESTINATION is substituted (a BrowserWindow needs a live
    // Electron runtime, which vitest never has). The redaction decision
    // under test stays entirely inside production code.
    completeTask(db, task.id, `Finished using ${CANARY} for auth`);
    const taskWithCanary = getTaskById(db, task.id)!;

    const sent: unknown[] = [];
    let didFinishLoad: (() => void) | null = null;
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        on: (event: string, cb: () => void) => {
          if (event === 'did-finish-load') didFinishLoad = cb;
        },
        send: (_channel: string, payload: unknown) => {
          sent.push(payload);
        },
      },
    } as unknown as Parameters<typeof wireStateDeltaOnLoad>[0];

    wireStateDeltaOnLoad(fakeWindow, db);
    expect(didFinishLoad, 'wireStateDeltaOnLoad never registered a did-finish-load handler').not.toBeNull();
    didFinishLoad!(); // the real window event that triggers the real send
    expect(sent, 'the real path emitted no snapshot at all').toHaveLength(1);

    const snapshotJson = JSON.stringify(sent[0]);
    expect(snapshotJson).not.toContain(CANARY);
    expect(snapshotJson).toContain('«redacted:secret»');

    // The same file's second producer of this outbound path. It has no
    // live caller yet, but it is exported production code that a future
    // milestone will wire up — so it is covered here rather than left to
    // be discovered unredacted later.
    const patched: unknown[] = [];
    const patchWindow = {
      isDestroyed: () => false,
      webContents: { on: () => {}, send: (_c: string, payload: unknown) => patched.push(payload) },
    } as unknown as Parameters<typeof pushPatch>[0];
    pushPatch(patchWindow, 'tasks', [taskWithCanary]);
    const patchJson = JSON.stringify(patched[0]);
    expect(patchJson).not.toContain(CANARY);
    expect(patchJson).toContain('«redacted:secret»');

    // (5) commit messages — a REAL git commit, real message read back via
    // `git log`, not commitTaskWork's own return value. A real file
    // change is required — `commitTaskWork` doesn't check "anything to
    // commit" itself, it stages and attempts the real `git commit`, which
    // fails on an empty diff (the same way it would for any employee
    // that made no real change).
    writeFileSync(path.join(worktree.path, 'work.txt'), 'real work\n', 'utf8');
    const commitResult = await commitTaskWork({
      db,
      activityLog,
      project: registeredProject,
      employee,
      worktree,
      task: taskWithCanary,
      validators: TRIVIAL_VALIDATORS,
    });
    expect(commitResult.outcome).toBe('committed');
    const commitMessage = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: worktree.path, encoding: 'utf8' });
    expect(commitMessage).not.toContain(CANARY);
    expect(commitMessage).toContain('«redacted:secret»');

    // (6) support bundles — the real handler, redacted before it's ever written to disk.
    const bundlePath = await buildSupportBundle(ctx, 'test-version');
    const bundleText = readFileSync(bundlePath, 'utf8');
    expect(bundleText).not.toContain(CANARY);
    expect(bundleText).toContain('«redacted:secret»');
  });
});
