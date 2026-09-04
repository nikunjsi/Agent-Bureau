import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { nowIso } from '../../../src/shared/models/ids';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee, getEmployeeById } from '../../../src/main/db/repositories/employees';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertTask } from '../../../src/main/db/repositories/tasks';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { GenericPtyAdapter } from '../../../src/main/engine/genericPtyAdapter';
import { noopSecretBroker, placeholderControlChannel, placeholderToolServer } from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §28 M3->M4 boundary check: "does the chain hold when driven as one
 * sequence, end to end, through the real Supervisor, rather than link by
 * link in isolation." Every piece exercised here already has its own
 * standalone test elsewhere (supervisor.test.ts, contract suite) — this
 * file exists specifically because standalone-passing links do not prove
 * the SEQUENCE holds, which is exactly the shape of bug probe()/
 * buildLaunchSpec() was (each half tested; the fact that nothing called
 * probe() before buildLaunchSpec() in the real flow was invisible to
 * either half's own test).
 *
 * Real DB, real repositories, real Supervisor, real ActivityLog — the
 * only fake is the engine adapter itself (FakeAdapter, per this session's
 * no-spend constraint). No hand-built shortcuts: this calls
 * `supervisor.assign(ctx)` exactly the way a real caller would and
 * observes what actually happens, rather than manually invoking adapter
 * methods to route around a gap.
 *
 * Was `it.fails` (M3->M4 boundary check, part 1): `Supervisor.assign()`
 * never called `adapter.send()` with the task's own content — every
 * existing Supervisor test passed without this ever being exercised,
 * because FakeAdapter's scripted events replay regardless of whether
 * `send()` was ever called. For a REAL adapter this was not cosmetic:
 * `events()` yields nothing until `send()` triggers a real spawn, so a
 * real employee assigned this way would sit in `starting` until the
 * heartbeat timeout eventually marked it `failed`, minutes later, with no
 * record of why. Fixed in `assign()` (§7.11 — the supervisor is the only
 * thing permitted to touch the adapter, so it delivers the task):
 * `adapter.send(ctx.task.body, 'task')`, routed through the adapter's own
 * §7.4 turn-boundary queue, not a spawn-time special case. This test
 * flipped from an expected failure to a real, permanent pass — no longer
 * `it.fails`, and it stays in the suite as the standing proof the chain
 * holds end to end, not just link by link.
 */
describe('End-to-end chain (M3->M4 boundary check): assign -> launch spec -> events -> turns -> usage -> stop', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-e2e-chain-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    const now = nowIso();
    db.prepare('INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(
      'dept1', 'engineering', 'Engineering', '{}', now, now,
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drives the full real sequence with no manual adapter calls from the test — reports what actually happens at each link', async () => {
    // ---- link 0: real project + real task, exactly what a real caller assembles ----
    const project = insertProject(db, {
      name: 'Test Project',
      path: tmpDir,
      kind: 'software',
    });
    const task = insertTask(db, {
      project_id: project.id,
      title: 'Add a login form',
      body: 'Please add a login form to the app.',
      acceptance_criteria: ['a login form exists'],
    });
    const role = insertRole(db, {
      key: 'developer',
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes code',
      system_prompt_path: 'prompts/developer.md',
      skills: ['code'],
      deliverable_types: ['code'],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: ['role'],
      autonomy_default: 'guided',
      sprite_key: 'dev',
      engine_options: { mode: 'structured' },
    } as never);
    const employee = insertEmployee(db, {
      name: 'Ravi',
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'off',
      status_detail: null,
      engine: 'claude-code',
      engine_mode: null,
      engine_version: null,
      model: null,
      session_id: null,
      pid: null,
      process_start_time: null,
      worktree_id: null,
      current_task_id: task.id,
      autonomy: 'guided',
      daily_budget_usd_micros: null,
      resume_at: null,
      heartbeat_at: null,
      consecutive_failures: 0,
      lifetime_spend_usd_micros: 0,
    } as never);

    const ctx: EmployeeContext = {
      employee,
      role,
      task, // real, non-null — this is what "assigned a task" means
      worktreePath: tmpDir,
      stateDir: tmpDir,
      memoryPack: '',
      decisionLog: '',
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: 'ask',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };

    // A realistic full-turn script: session starts, a turn begins, content
    // streams, a tool runs, the turn completes with real usage, the
    // adapter goes idle, then finishes cleanly. Everything downstream of
    // "the task was delivered" that this test can meaningfully check.
    const adapter = new FakeAdapter({
      events: [
        { t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' },
        { t: 'turn.started', turnIndex: 0 },
        { t: 'text.delta', text: 'Adding a login form.' },
        { t: 'tool.requested', callId: 'c1', tool: 'Write', rawTool: 'Write', args: {}, preview: 'login.tsx' },
        { t: 'tool.completed', callId: 'c1', ok: true, excerpt: 'wrote login.tsx', ms: 12 },
        {
          t: 'turn.completed',
          turnIndex: 0,
          usage: { tokensIn: 100, tokensOut: 50, tokensCacheRead: 0, tokensCacheWrite: 0, model: 'm', costUsdMicros: 500 },
        },
        { t: 'idle' },
        { t: 'finished', reason: 'completed', summary: null },
      ],
    });

    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter });

    // ---- link 1: assign() — the ONLY call this test makes ----
    await supervisor.assign(ctx);
    await new Promise((resolve) => setTimeout(resolve, 100)); // let consumeEvents() drain the scripted stream

    // ---- link 2: was the task's own content ever actually delivered? ----
    // This is the link probe()/buildLaunchSpec() taught us to check for:
    // every OTHER link below can pass purely because FakeAdapter replays
    // its scripted events regardless of whether send() was ever called
    // ("no adapter ever advances on its own" is true of the SCRIPT, not
    // of whether the caller drove it correctly).
    const sentTaskBody = adapter.sentMessages.some((m) => m.kind === 'task' && m.text === task.body);

    // ---- link 3: launch spec built, with envKeys logged (never values) ----
    const launchEvents = db.prepare("SELECT * FROM events WHERE type = 'employee.started'").all() as Array<{ payload: string }>;

    // ---- link 4: turns counted ----
    const turnsCompleted = supervisor.turnsCompleted;

    // ---- link 5: usage recorded ----
    const usageRows = db.prepare('SELECT * FROM usage WHERE employee_id = ? AND task_id = ?').all(employee.id, task.id) as Array<{
      cost_usd_micros: number;
    }>;

    // ---- link 6: stopped cleanly ----
    await supervisor.stop();
    const finalStatus = getEmployeeById(db, employee.id)?.status;

    // Report every link's actual state — this test's real job is to make
    // exactly one of these assertions the one that fails, not to hide it
    // among unrelated ones.
    expect({
      launchSpecLogged: launchEvents.length === 1,
      sentTaskBody,
      turnsCompleted,
      usageRowCount: usageRows.length,
      finalStatus,
    }).toEqual({
      launchSpecLogged: true,
      sentTaskBody: true,
      turnsCompleted: 1,
      usageRowCount: 1,
      finalStatus: 'off',
    });
  });

  /**
   * The second, more important gap this boundary check surfaced: Supervisor
   * had never been driven together with a REAL adapter in any test — only
   * FakeAdapter, whose scripted events replay whether or not send() was
   * ever called, which is exactly what let the assign()-never-sends bug
   * above hide undetected. This closes that combination permanently, with
   * the real GenericPtyAdapter and the deterministic scripted local CLI
   * (free, zero spend, no engine installed required) — assign, the task
   * body actually delivered and echoed back by a real process, clean stop.
   */
  it('Supervisor + a REAL adapter (GenericPtyAdapter), end to end — the combination no test drove before', async () => {
    const project = insertProject(db, { name: 'Real Adapter Test', path: tmpDir, kind: 'software' });
    const taskBody = 'hello from the real end-to-end chain test';
    const task = insertTask(db, {
      project_id: project.id,
      title: 'Say hello',
      body: taskBody,
      acceptance_criteria: ['the CLI echoes the greeting'],
    });
    const scriptPath = path.resolve('tests/helpers/scriptedPtyCli.cjs');
    const role = insertRole(db, {
      key: 'scripted-cli-real',
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Scripted CLI',
      description: 'test target',
      system_prompt_path: 'prompts/scripted-cli.md',
      skills: ['code'],
      deliverable_types: ['code'],
      engine_preference: ['generic-pty'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: ['role'],
      autonomy_default: 'ask',
      sprite_key: 'dev',
      engine_options: {
        mode: 'pty',
        command: process.execPath,
        args: [scriptPath],
        ready_pattern: '(?:^|\\r|\\n)>[^\\r\\n]*$',
        done_pattern: '^\\[done\\]',
        interrupt: '\x03',
        ready_debounce_ms: 100,
      },
    } as never);
    const employee = insertEmployee(db, {
      name: 'Real Adapter Ravi',
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'off',
      status_detail: null,
      engine: 'generic-pty',
      engine_mode: null,
      engine_version: null,
      model: null,
      session_id: null,
      pid: null,
      process_start_time: null,
      worktree_id: null,
      current_task_id: task.id,
      autonomy: 'ask',
      daily_budget_usd_micros: null,
      resume_at: null,
      heartbeat_at: null,
      consecutive_failures: 0,
      lifetime_spend_usd_micros: 0,
    } as never);

    const ctx: EmployeeContext = {
      employee,
      role,
      task,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      memoryPack: '',
      decisionLog: '',
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: 'ask',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };

    const adapter = new GenericPtyAdapter();
    const supervisor = new Supervisor(employee.id, { db, activityLog, adapter, terminalBroadcaster: { coalesceMs: 1 } });

    // Observe raw output the same way a real xterm.js window would: via
    // the supervisor's own TerminalBroadcaster, not an adapter-internal
    // hook — proving delivery through the same path a real user watches.
    let observedRaw = '';
    supervisor.terminal.attach((chunk) => {
      observedRaw += Buffer.from(chunk.base64, 'base64').toString('utf8');
    });

    await supervisor.assign(ctx); // the ONLY call this test makes — no manual adapter.send()

    // Wait for the real echo to actually appear, rather than a fixed guess.
    const deadline = Date.now() + 5000;
    while (!observedRaw.includes(`echo: ${taskBody}`) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(observedRaw).toContain(`echo: ${taskBody}`);

    await supervisor.stop();
    expect(getEmployeeById(db, employee.id)?.status).toBe('off');

    // Clean stop, verified against the real process tree — not an
    // internal flag (§7.8 test 8's own standard).
    const { execFileSync } = await import('node:child_process');
    const psOut = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine"],
      { encoding: 'utf8' },
    );
    expect(psOut).not.toContain('scriptedPtyCli.cjs');
  }, 15_000);
});
