import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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
import {
  insertEmployee,
  setEmployeeCurrentTask,
  getEmployeeById,
} from '../../src/main/db/repositories/employees';
import { insertProject } from '../../src/main/db/repositories/projects';
import { insertTask, getTaskById } from '../../src/main/db/repositories/tasks';
import { seedSettingsDefaults } from '../../src/main/db/settingsLoader';
import { provisionTestAnthropicKey, testKeyUnavailableReason } from '../helpers/realEngineKey';
import { applyRealRunBudgets } from '../helpers/realRunBudgets';
import { newId, nowIso } from '../../src/shared/models/ids';
import type { EmployeeContext } from '../../src/shared/engine/types';

/**
 * **What `--bare` actually does to Bureau's gate** (M11 row S1-7).
 *
 * Claude Code is making `--bare` the default for `-p`. Its own `--help`
 * says the mode skips hooks — and Bureau's PreToolUse hook **is** the
 * policy gate (§11.3): every tool call an employee makes is allowed or
 * denied by it. If that is true, then a session launched under `--bare` is
 * ungoverned, and the CLI turning it on by default would make every
 * employee ungoverned without a line of Bureau changing.
 *
 * This project does not take a capability from documentation (§7.12:
 * "probe each candidate engine's real capabilities and fill this table
 * from what you observe"). So this measures it, once, for real, and the
 * production decision in `buildLaunchSpec` follows the measurement.
 *
 * **Honest about what it drives** (standing rule 1): the ctx, the launch
 * spec, the config files, the MCP server, the hook registration and the
 * turn argv are all the real adapter's — `buildLaunchSpec` and
 * `buildTurnArgs`, the same two functions production spawns from. What
 * this test does itself is add `--bare` to that argv and spawn it,
 * because the adapter does not pass `--bare` and (given the result below)
 * never will. It is a measurement of the CLI, made through Bureau's own
 * launch spec.
 */
const resolvedPathForRealClaude = await buildResolvedPath();
const realClaudePath = resolveBinaryAbsolutePath('claude', resolvedPathForRealClaude);
const explicitlyOptedIn = process.env.BUREAU_RUN_REAL_ENGINE_TESTS === '1';
const keyUnavailable = testKeyUnavailableReason();
const shouldRun = realClaudePath !== null && explicitlyOptedIn && keyUnavailable === null;

function skipReason(): string {
  if (!realClaudePath) return 'claude CLI not found via the resolved-PATH service on this machine';
  if (!explicitlyOptedIn)
    return 'BUREAU_RUN_REAL_ENGINE_TESTS is not set — real-engine tests are opt-in, not automatic';
  if (keyUnavailable !== null) return keyUnavailable;
  return '';
}

if (!shouldRun) {
  console.log(`[realBareMode.test.ts] skipping: ${skipReason()}`);
}

/**
 * The cheapest model that can call one tool. The question here is whether
 * the CLI runs the hook, which no model influences, so the measurement is
 * deliberately run on the cheapest one rather than the role's tier.
 */
const MEASUREMENT_MODEL = 'claude-haiku-4-5-20251001';

const PROMPT =
  'Call the bureau_report_status tool exactly once with status_detail "bare mode check", ' +
  'then reply with the single word DONE. Do not call any other tool.';

// The row ID stays in the comment above and out of every title (plan §F):
// `securitySuiteCoverage` reads an S-number out of test code.
describe('--bare, measured against the pinned CLI', () => {
  it.skipIf(!shouldRun)(
    'a turn launched with --bare: does Bureau still see the MCP call, and does the hook still run?',
    async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-bare-'));
      let db: Database.Database | undefined;
      let activityLog: ActivityLog | undefined;
      let server: ControlChannelServer | undefined;
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
        const broker = await provisionTestAnthropicKey(db);
        const now = nowIso();
        db.prepare(
          'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
        ).run('dept1', 'engineering', 'Engineering', '{}', now, now);

        const tokenRegistry = new TokenRegistry();
        const supervisorRegistry = new SupervisorRegistry();
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
          name: `bare-test-${newId()}`,
          role_key: role.full_key,
          is_director: false,
          desk_x: 0,
          desk_y: 0,
          sprite_variant: 'a',
          status: 'off',
          engine: 'claude-code',
          autonomy: 'guided',
        } as never);
        const project = insertProject(db, {
          name: 'bare mode measurement',
          path: tmpDir,
          kind: 'software',
        });
        const task = insertTask(db, {
          project_id: project.id,
          title: 'bare mode measurement',
          body: PROMPT,
          acceptance_criteria: ['the status was reported'],
        });
        db.prepare('UPDATE tasks SET assignee_employee_id = ? WHERE id = ?').run(
          employee.id,
          task.id,
        );
        setEmployeeCurrentTask(db, employee.id, task.id);

        const worktreePath = mkdtempSync(path.join(tmpdir(), 'bureau-bare-worktree-'));
        const adapter = createRealClaudeCodeAdapterForTests(db);
        const spawned = await spawnSupervisedEmployee({
          db,
          activityLog,
          tokenRegistry,
          supervisorRegistry,
          controlChannelPort: port,
          employeeId: employee.id,
          adapter,
          baseDir: tmpDir,
        });

        const ctx: EmployeeContext = {
          employee: getEmployeeById(db, employee.id)!,
          role,
          task: getTaskById(db, task.id),
          worktreePath,
          stateDir: spawned.stateDir,
          baseDir: spawned.stateDir,
          broker,
          modelId: MEASUREMENT_MODEL,
          turnBudgetCapUsdMicros: 250_000,
          ...buildControlChannelAndToolServerContext(spawned, resolveBureauToolsScriptPathForTests),
        };

        // The real spec, the real config files, the real turn argv — then
        // --bare, which is the one thing this test adds.
        await adapter.start(ctx);
        const spec = await adapter.buildLaunchSpec(ctx);
        for (const file of spec.configFiles) {
          mkdirSync(path.dirname(file.path), { recursive: true });
          writeFileSync(file.path, file.content, 'utf8');
        }
        const secrets = await ctx.broker.resolveForSpawn({
          employeeId: employee.id,
          engineKey: 'claude-code',
        });
        const args = [...adapter.buildTurnArgs(PROMPT, spec), '--bare'];

        // (c) the adapter's own files are the ones this run uses.
        expect(args).toContain('--settings');
        expect(args).toContain('--mcp-config');
        expect(spec.configFiles.map((f) => f.path).sort()).toEqual(
          [args[args.indexOf('--mcp-config') + 1], args[args.indexOf('--settings') + 1]].sort(),
        );

        const stdout = await new Promise<string>((resolve, reject) => {
          const child = spawn(spec.command, args, {
            cwd: spec.cwd,
            env: { ...spec.env, ...secrets.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const chunks: string[] = [];
          const stderr: string[] = [];
          child.stdout.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
          child.stderr.on('data', (d: Buffer) => stderr.push(d.toString('utf8')));
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`--bare turn timed out; stderr: ${stderr.join('')}`));
          }, 120_000);
          child.on('exit', () => {
            clearTimeout(timer);
            resolve(chunks.join(''));
          });
          child.on('error', reject);
        });

        const events = (
          db.prepare('SELECT type FROM events ORDER BY seq').all() as Array<{ type: string }>
        ).map((row) => row.type);

        // (a) does Bureau's MCP server load and reach the Core?
        const mcpReached = events.includes('employee.status_reported');
        // (b) does the PreToolUse hook run? `tool.requested` is written by
        // the control channel when the real hook binary calls it, and by
        // nothing else — so its absence is the hook's absence.
        const hookRan = events.includes('tool.requested');

        console.log(
          `[--bare measurement] MCP reached the Core: ${mcpReached}; PreToolUse hook ran: ${hookRan}`,
        );
        console.log(`[--bare measurement] events: ${JSON.stringify(events)}`);
        const cost = /"total_cost_usd":([0-9.]+)/.exec(stdout)?.[1];
        console.log(`[real-run cost] realBareMode: ${cost ? `$${cost}` : 'cost not reported'}`);

        // **The measurement, asserted as the finding it is.** The CLI's own
        // help says --bare skips hooks; this is that claim, checked against
        // the real binary on the pinned version. If a later CLI starts
        // running hooks under --bare, this test fails and the decision in
        // buildLaunchSpec gets revisited — which is exactly what should
        // happen, rather than the flag being passed on a stale reading.
        expect(
          hookRan,
          'if this now passes, --bare no longer skips hooks, and the decision never to pass it should be revisited (see the plan row named in the comment above)',
        ).toBe(false);
        expect(mcpReached, 'the MCP server is loaded from --mcp-config, which --bare keeps').toBe(
          true,
        );
      } finally {
        server?.stop();
        activityLog?.close();
        db?.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  if (!shouldRun) {
    it.skip(`(the --bare measurement is skipped: ${skipReason()})`, () => {});
  }
});
