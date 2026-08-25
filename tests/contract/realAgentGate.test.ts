import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { ActivityLog } from '../../src/main/db/activityLog';
import { ControlChannelServer } from '../../src/main/controlChannel/server';
import { TokenRegistry } from '../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../src/main/engine/supervisorRegistry';
import { spawnSupervisedEmployee, buildControlChannelAndToolServerContext } from '../../src/main/engine/spawnSupervisedEmployee';
import { ClaudeCodeAdapter } from '../../src/main/engine/claudeCodeAdapter';
import { buildResolvedPath, resolveBinaryAbsolutePath } from '../../src/main/engine/resolvedPath';
import { insertRole } from '../../src/main/db/repositories/roles';
import { insertEmployee, setEmployeeCurrentTask, getEmployeeById } from '../../src/main/db/repositories/employees';
import { insertProject } from '../../src/main/db/repositories/projects';
import { insertTask, getTaskById } from '../../src/main/db/repositories/tasks';
import { noopSecretBroker } from '../../src/shared/engine/seams';
import { newId, nowIso } from '../../src/shared/models/ids';
import type { EmployeeContext } from '../../src/shared/engine/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §28 M4 close-out: "M4 closes here." The real gate — a real agent, in a
 * real worktree, through the REAL control channel (real ControlChannelServer,
 * real bureau-tools.js spawned BY THE CLI over a real MCP config, real
 * bureau-hook.js gating every call via a real PreToolUse hook) — sets its
 * status, asks the Director a question, and completes a task via
 * bureau_task_done, all three visible in the database AND the activity
 * log, with the supervisor taking the `review`/`idle` branch (task_reported)
 * rather than `blocked`/ended_without_report.
 *
 * Gated exactly like realEngineSpawn.test.ts (§7.8's "real engines when
 * present" contract half): the real `claude` CLI must resolve on this
 * machine AND BUREAU_RUN_REAL_ENGINE_TESTS must be explicitly set. This is
 * the one real spawn for M4 session 2 — costs a small, bounded amount
 * (ClaudeCodeAdapter's own costSafetyArgs(): the cheapest model tier, a
 * hard $0.05 --max-budget-usd ceiling).
 */
const resolvedPathForRealClaude = await buildResolvedPath();
const realClaudePathForGate = resolveBinaryAbsolutePath('claude', resolvedPathForRealClaude);
const explicitlyOptedIn = process.env.BUREAU_RUN_REAL_ENGINE_TESTS === '1';
const shouldRun = realClaudePathForGate !== null && explicitlyOptedIn;

function skipReason(): string {
  if (!realClaudePathForGate) return 'claude CLI not found via the resolved-PATH service on this machine';
  if (!explicitlyOptedIn) return 'BUREAU_RUN_REAL_ENGINE_TESTS is not set — real-engine tests are opt-in, not automatic';
  return '';
}
if (!shouldRun) {
  console.log(`[realAgentGate.test.ts] skipping: ${skipReason()}`);
}

/** Same mechanism realEngineSpawn.test.ts already established and verified
 * twice this project (M3 session 2): copying both ~/.claude.json and
 * ~/.claude/.credentials.json into an isolated per-employee config dir
 * restores a genuinely working, authenticated session. Stand-in for real
 * SecretBroker credential provisioning (M6), not production code. */
function seedIsolatedAuth(stateDir: string): boolean {
  const claudeJson = path.join(homedir(), '.claude.json');
  const credentials = path.join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(claudeJson) || !existsSync(credentials)) return false;
  const claudeConfigDir = path.join(stateDir, 'claude');
  mkdirSync(claudeConfigDir, { recursive: true });
  copyFileSync(claudeJson, path.join(claudeConfigDir, '.claude.json'));
  copyFileSync(credentials, path.join(claudeConfigDir, '.credentials.json'));
  return true;
}

async function waitUntilTrue(predicate: () => boolean, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

const TASK_BODY = `You are running an automated end-to-end integration test of Bureau's tool integration. You have three real tools available right now: bureau_report_status, bureau_ask_director, and bureau_task_done.

Call all three, in this exact order, then stop:

1. bureau_report_status with status_detail: "running the M4 gate test"
2. bureau_ask_director with question: "This is a test question as part of an automated check - no real answer is needed.", context: "automated test", urgency: "low"
3. bureau_task_done with summary: "M4 gate test: all three tool calls completed successfully.", verified: ["all three tools were called"], not_verified: [], artifacts: []

Do not edit any files, do not run any other commands, and do not call any other tools. Just call these three tools in order and then stop.`;

describe('THE M4 GATE (§28): a real agent, real worktree, real control channel — status, ask, done', () => {
  it.skipIf(!shouldRun)(
    'sets status, asks the Director, and completes its task via bureau_task_done — supervisor takes the review branch',
    async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-m4-gate-'));
      let db: Database.Database | undefined;
      let activityLog: ActivityLog | undefined;
      let server: ControlChannelServer | undefined;
      try {
        const dbPath = path.join(tmpDir, 'bureau.db');
        db = openConnection(dbPath);
        await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
        activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
        const now = nowIso();
        db.prepare('INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(
          'dept1', 'engineering', 'Engineering', '{}', now, now,
        );

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
          name: `gate-test-${newId()}`,
          role_key: role.full_key,
          is_director: false,
          desk_x: 0,
          desk_y: 0,
          sprite_variant: 'a',
          status: 'off',
          engine: 'claude-code',
          autonomy: 'guided',
        } as never);
        const project = insertProject(db, { name: 'M4 gate test project', path: tmpDir, kind: 'software' });
        const task = insertTask(db, {
          project_id: project.id,
          title: 'M4 gate test task',
          body: TASK_BODY,
          acceptance_criteria: ['all three bureau_* tools were called'],
        });
        db.prepare('UPDATE tasks SET assignee_employee_id = ? WHERE id = ?').run(employee.id, task.id);
        setEmployeeCurrentTask(db, employee.id, task.id);

        const worktreePath = mkdtempSync(path.join(tmpdir(), 'bureau-m4-gate-worktree-'));

        const spawned = await spawnSupervisedEmployee({
          db,
          activityLog,
          tokenRegistry,
          supervisorRegistry,
          controlChannelPort: port,
          employeeId: employee.id,
          adapter: new ClaudeCodeAdapter(),
          baseDir: tmpDir,
        });

        const seeded = seedIsolatedAuth(spawned.stateDir);
        expect(seeded, 'no real ~/.claude.json + ~/.claude/.credentials.json to copy on this machine').toBe(true);

        const freshTask = getTaskById(db, task.id);
        if (!freshTask) throw new Error('task disappeared before assign()');

        const ctx: EmployeeContext = {
          employee,
          role,
          task: freshTask,
          worktreePath,
          stateDir: spawned.stateDir,
          memoryPack: '',
          decisionLog: '',
          broker: noopSecretBroker,
          effectiveAutonomy: 'guided',
          ...buildControlChannelAndToolServerContext(spawned),
        };

        await spawned.supervisor.assign(ctx);

        // Real network + real model turn + three real tool round-trips
        // through the real hook and the real control channel — generous,
        // not tight.
        const settled = await waitUntilTrue(
          () => spawned.supervisor.currentState === 'idle' || spawned.supervisor.currentState === 'blocked' || spawned.supervisor.currentState === 'failed',
          120_000,
        );
        expect(settled, `supervisor never settled; state=${spawned.supervisor.currentState}`).toBe(true);

        // ---- show the actual rows and log lines (explicit ask) ----
        const finalEmployee = getEmployeeById(db, employee.id);
        const finalTask = getTaskById(db, task.id);
        const messageRow = db.prepare('SELECT * FROM messages WHERE from_addr = ?').get(employee.id);
        const events = db.prepare('SELECT seq, type, severity, payload FROM events ORDER BY seq').all();
        console.log('[M4 GATE] final employee row:', JSON.stringify(finalEmployee));
        console.log('[M4 GATE] final task row:', JSON.stringify(finalTask));
        console.log('[M4 GATE] messages row:', JSON.stringify(messageRow));
        console.log('[M4 GATE] activity log:', JSON.stringify(events, null, 2));

        // ---- the actual assertions ----
        expect(spawned.supervisor.currentState, 'supervisor must take the review branch, not blocked/ended_without_report').toBe('idle');
        expect(finalEmployee?.status_detail).toBe('running the M4 gate test');
        expect(messageRow).toBeDefined();
        expect(finalTask?.status).toBe('review');
        expect(finalTask?.result_summary).toBe('M4 gate test: all three tool calls completed successfully.');

        const eventTypes = (events as Array<{ type: string }>).map((e) => e.type);
        expect(eventTypes).toContain('employee.status_reported');
        expect(eventTypes).toContain('message.sent');
        expect(eventTypes).toContain('task.submitted_for_review');
        expect(eventTypes).toContain('tool.requested');
        expect(eventTypes).toContain('tool.allowed');
        expect(eventTypes).not.toContain('tool.denied');
        const lastIdleEvent = (events as Array<{ type: string; payload: string | null }>)
          .filter((e) => e.type === 'employee.idle')
          .pop();
        expect(JSON.parse(lastIdleEvent?.payload ?? 'null')).toEqual({ reason: 'task_reported' });

        await spawned.supervisor.stop();
      } finally {
        await server?.stop();
        activityLog?.close();
        db?.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    150_000,
  );
});
