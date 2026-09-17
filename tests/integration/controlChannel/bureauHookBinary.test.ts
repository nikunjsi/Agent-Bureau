import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { PolicyHoldRegistry } from '../../../src/main/controlChannel/policyHoldRegistry';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { seedEmployee } from '../../helpers/dbFixtures';
import type { Verdict } from '../../../src/shared/policy/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

interface HookRun {
  readonly exitCode: number | null;
  readonly decision: { permissionDecision: string; permissionDecisionReason: string } | null;
  readonly stdout: string;
}

/**
 * N-14 / §7.10: every tool call an employee makes passes through
 * `bureau-hook`, and fail-closed is that script's own job (a timed-out
 * PreToolUse hook fails OPEN in the engine). Its deny branches were only
 * ever exercised through a paid real-engine run. This runs the real script,
 * bundled exactly as `scripts/build.mjs` bundles it, as a real process via
 * `process.execPath`, and asserts both halves of what the engine reads: the
 * stdout JSON decision and the exit code (2 = block, 0 = proceed).
 *
 * Bundled here from source rather than read from `dist/`, so a stale build
 * cannot make this pass, and a mutation to the source is what gets run.
 */
describe('S11 hook_failure_denies: bureau-hook, the real script as a real process (N-14, §7.10)', () => {
  let bundleDir: string;
  let hookPath: string;
  let tmpDir: string;

  beforeAll(async () => {
    bundleDir = mkdtempSync(path.join(tmpdir(), 'bureau-hook-bundle-'));
    await esbuild.build({
      entryPoints: [path.resolve('resources/bin/bureau-hook.ts')],
      outdir: bundleDir,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      logLevel: 'silent',
    });
    hookPath = path.join(bundleDir, 'bureau-hook.js');
  });

  afterAll(() => {
    rmSync(bundleDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-hook-run-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runHook(env: NodeJS.ProcessEnv, toolName = 'Bash'): Promise<HookRun> {
    return new Promise((resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
      if (env['BUREAU_CONTROL_FILE'] === undefined) delete childEnv['BUREAU_CONTROL_FILE'];
      const child = spawn(process.execPath, [hookPath], { env: childEnv, windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (exitCode) => {
        let decision: HookRun['decision'] = null;
        try {
          decision = (
            JSON.parse(stdout.trim()) as {
              hookSpecificOutput: NonNullable<HookRun['decision']>;
            }
          ).hookSpecificOutput;
        } catch {
          decision = null;
        }
        resolve({ exitCode, decision, stdout });
      });
      child.stdin.end(
        JSON.stringify({
          tool_name: toolName,
          tool_input: { command: 'echo hi' },
          tool_use_id: 'call-1',
        }),
      );
    });
  }

  function expectDenied(run: HookRun, reasonPart: string): void {
    expect(run.decision, `no decision JSON on stdout: ${run.stdout}`).not.toBeNull();
    expect(run.decision?.permissionDecision).toBe('deny');
    expect(run.decision?.permissionDecisionReason).toContain(reasonPart);
    expect(run.exitCode).toBe(2);
  }

  it('no environment: denies, exit 2', async () => {
    expectDenied(await runHook({ BUREAU_CONTROL_FILE: undefined }), 'BUREAU_CONTROL_FILE');
  });

  it('control.json missing: denies, exit 2', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.json');
    expectDenied(await runHook({ BUREAU_CONTROL_FILE: missing }), 'could not read control.json');
  });

  it('control.json malformed: denies, exit 2', async () => {
    const malformed = path.join(tmpDir, 'control.json');
    writeFileSync(malformed, '{"port": "not a number"', 'utf8');
    expectDenied(await runHook({ BUREAU_CONTROL_FILE: malformed }), 'could not read control.json');
  });

  it('the Core is killed while the hook waits on it: denies, exit 2', async () => {
    // A real Core-shaped process that accepts the request and never answers,
    // then is killed mid-wait.
    const core: ChildProcess = spawn(
      process.execPath,
      [
        '-e',
        "const s=require('http').createServer(()=>{});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
      ],
      { windowsHide: true },
    );
    const port = await new Promise<number>((resolve) => {
      core.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    const controlFile = path.join(tmpDir, 'control.json');
    writeFileSync(
      controlFile,
      JSON.stringify({ port, token: 'tok', employeeId: '01J0000000000000000000000A' }),
      'utf8',
    );

    const pending = runHook({ BUREAU_CONTROL_FILE: controlFile });
    await new Promise((resolve) => setTimeout(resolve, 400));
    core.kill('SIGKILL');
    const run = await pending;
    expect(run.decision?.permissionDecision).toBe('deny');
    expect(run.exitCode).toBe(2);
  });

  describe('against a live Core', () => {
    let db: Database.Database;
    let activityLog: ActivityLog;
    let server: ControlChannelServer;
    let controlFile: string;

    beforeEach(async () => {
      const dbPath = path.join(tmpDir, 'bureau.db');
      db = openConnection(dbPath);
      await runMigrations({
        db,
        dbPath,
        migrationsDir: REAL_MIGRATIONS_DIR,
        backupsDir: path.join(tmpDir, 'backups'),
      });
      activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
      const tokenRegistry = new TokenRegistry();
      const employeeId = seedEmployee(db).id;
      const token = tokenRegistry.mint(employeeId);
      server = new ControlChannelServer({
        db,
        activityLog,
        tokenRegistry,
        supervisorRegistry: new SupervisorRegistry(),
        policyHoldRegistry: new PolicyHoldRegistry(),
        maxHoldMinutes: 5,
        bodyCapBytes: 64_000,
        evaluatePolicy: async (request): Promise<Verdict> =>
          request.tool === 'Read'
            ? { effect: 'allow', ruleId: 'test.allow' }
            : { effect: 'deny', ruleId: 'test.deny', reason: 'test fixture denies this tool' },
      });
      const port = await server.start();
      controlFile = path.join(tmpDir, 'control.json');
      writeFileSync(controlFile, JSON.stringify({ port, token, employeeId }), 'utf8');
    });

    afterEach(async () => {
      await server.stop();
      activityLog.close();
      db.close();
    });

    it('an allow from the Core: allow, exit 0', async () => {
      const run = await runHook({ BUREAU_CONTROL_FILE: controlFile }, 'Read');
      expect(run.decision?.permissionDecision).toBe('allow');
      expect(run.exitCode).toBe(0);
    });

    it('a deny from the Core: deny, exit 2', async () => {
      const run = await runHook({ BUREAU_CONTROL_FILE: controlFile }, 'Bash');
      expect(run.decision?.permissionDecision).toBe('deny');
      expect(run.exitCode).toBe(2);
    });
  });
});
