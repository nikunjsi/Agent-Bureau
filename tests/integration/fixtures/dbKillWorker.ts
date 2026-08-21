/**
 * The worker driven by tests/integration/killPoints.test.ts (§28 M1 gate:
 * "kill the process at 20 scripted points; every one reconciles cleanly
 * with no lost committed state"). Runs as a plain Node process (no
 * Electron needed — better-sqlite3's N-API prebuild loads fine under
 * either, verified during planning), performs 20 named steps against a
 * real database using the real repositories, and prints `STEP_DONE <n>`
 * after each one completes. The parent test force-kills this process
 * after seeing exactly `k` markers, for k = 1..20, then reopens the DB
 * fresh and asserts on the result.
 *
 * Steps 15 and 16 are deliberately split around the exact file-then-
 * mirror boundary §11.6 describes, rather than going through the
 * `ActivityLog` class (which does both atomically from the caller's point
 * of view) — this is the one place the test needs to control that
 * boundary directly.
 */
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { insertMirrorRow } from '../../../src/main/db/activityLog';
import { newId, nowIso } from '../../../src/shared/models/ids';
import type { ActivityLogEntry } from '../../../src/shared/models/event';
import { insertDepartment } from '../../../src/main/db/repositories/departments';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertBrief, approveBrief } from '../../../src/main/db/repositories/briefs';
import { insertPlan } from '../../../src/main/db/repositories/plans';
import { insertPhase } from '../../../src/main/db/repositories/phases';
import { insertTask, setTaskStatus } from '../../../src/main/db/repositories/tasks';
import { insertTaskDep } from '../../../src/main/db/repositories/taskDeps';
import { insertWorktree, acquireWorktreeLease } from '../../../src/main/db/repositories/worktrees';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertConversationMessage } from '../../../src/main/db/repositories/conversationMessages';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { insertUsage } from '../../../src/main/db/repositories/usage';
import { appendFileSync, fsyncSync, openSync, closeSync, readSync } from 'node:fs';

/**
 * Prints the step marker, then **blocks the thread** (a synchronous stdin
 * read, not just an event-loop yield) until the parent sends one byte of
 * acknowledgement. Every step in this script runs synchronously and fast
 * (better-sqlite3 is sync), so without this the child can race straight
 * past the intended kill point before the parent's kill signal — sent only
 * after it observes the marker over a real OS pipe — has any chance to
 * arrive. Blocking here pins the child exactly at each boundary until the
 * parent explicitly allows it to continue; for the one step the parent
 * never acknowledges, the child simply stays frozen there until killed.
 */
function announceAndWaitForAck(step: number): void {
  process.stdout.write(`STEP_DONE ${step}\n`);
  const buffer = Buffer.alloc(1);
  try {
    readSync(0, buffer, 0, 1, null);
  } catch {
    // stdin closed (e.g. the parent killed us mid-read) — nothing to do.
  }
}

async function main(): Promise<void> {
  const dbPath = process.env['BUREAU_KILLTEST_DB_PATH'];
  const activityLogPath = process.env['BUREAU_KILLTEST_ACTIVITY_LOG_PATH'];
  const migrationsDir = process.env['BUREAU_KILLTEST_MIGRATIONS_DIR'];
  const backupsDir = process.env['BUREAU_KILLTEST_BACKUPS_DIR'];
  if (!dbPath || !activityLogPath || !migrationsDir || !backupsDir) {
    throw new Error('dbKillWorker: missing required BUREAU_KILLTEST_* env vars');
  }

  const db = openConnection(dbPath);
  await runMigrations({ db, dbPath, migrationsDir, backupsDir });

  // Step 1
  insertDepartment(db, {
    key: 'engineering',
    name: 'Engineering',
    pack_id: null,
    room_rect: { x: 0, y: 0, w: 10, h: 8 },
    theme: null,
    enabled: true,
  });
  announceAndWaitForAck(1);

  // Step 2
  const role = insertRole(db, {
    key: 'director',
    department_key: 'engineering',
    pack_id: 'core',
    priority: 50,
    version: '1.0.0',
    title: 'Director',
    description: 'Runs the company',
    system_prompt_path: 'prompts/director.md',
    skills: [],
    deliverable_types: [],
    engine_preference: ['claude-code'],
    model_preference: null,
    tools_allow: [],
    tools_deny: [],
    network_allow: [],
    memory_scopes: [],
    autonomy_default: 'guided',
    max_turns: 40,
    max_attempts: 2,
    wall_clock_timeout_s: 2400,
    budget_usd_micros: null,
    sprite_key: 'director',
    role_options: {},
    enabled: true,
  });
  announceAndWaitForAck(2);

  // Steps 3-5: the §5.1.1 bootstrap, inside one transaction on purpose —
  // a kill between 3 and 5 must leave *nothing* committed (proving
  // atomicity), only after 5 does the company+director both durably exist.
  let companyId = '';
  let directorEmployeeId = '';
  const bootstrapTxn = db.transaction(() => {
    companyId = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO companies (id, name, home_path, director_employee_id, floor_layout, settings, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(companyId, 'Kill-Point Test Co', 'C:\\killtest', '{}', '{}', now, now);
    announceAndWaitForAck(3);

    directorEmployeeId = newId();
    db.prepare(
      `INSERT INTO employees (id, name, role_key, desk_x, desk_y, sprite_variant, status, engine, autonomy, hired_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(directorEmployeeId, 'Director', role.full_key, 0, 0, 'a', 'idle', 'claude-code', 'guided', now, now, now);
    announceAndWaitForAck(4);

    db.prepare('UPDATE companies SET director_employee_id = ? WHERE id = ?').run(directorEmployeeId, companyId);
  });
  bootstrapTxn();
  announceAndWaitForAck(5);

  // Step 6
  const project = insertProject(db, {
    name: 'Kill Point Project',
    path: 'C:\\killtest\\project',
    repo_initialised: false,
    base_ref: 'main',
    protected_refs: ['main', 'master'],
    kind: 'software',
    stage: 'intake',
    brief_id: null,
    plan_id: null,
    budget_usd_micros: null,
    spend_usd_micros: 0,
  });
  announceAndWaitForAck(6);

  // Step 7
  const brief = insertBrief(db, {
    project_id: project.id,
    version: 1,
    content: { goal: 'Ship it' },
    markdown: '# Brief',
    status: 'draft',
    approved_at: null,
  });
  announceAndWaitForAck(7);

  // Step 8
  approveBrief(db, brief.id);
  announceAndWaitForAck(8);

  // Step 9
  const plan = insertPlan(db, {
    project_id: project.id,
    brief_id: brief.id,
    version: 1,
    content: { phases: [] },
    estimated_cost_usd_micros: null,
    status: 'draft',
    approved_at: null,
  });
  announceAndWaitForAck(9);

  // Step 10
  const phase = insertPhase(db, {
    plan_id: plan.id,
    ordinal: 1,
    name: 'Phase 1',
    goal: 'Get it working',
    review_required: true,
    status: 'pending',
  });
  announceAndWaitForAck(10);

  // Step 11
  const task = insertTask(db, {
    project_id: project.id,
    phase_id: phase.id,
    parent_task_id: null,
    title: 'Do the thing',
    body: 'Do the thing well',
    acceptance_criteria: ['it builds', 'tests pass'],
    required_skills: [],
    deliverable_type: 'code',
    assignee_employee_id: null,
    excluded_employees: [],
    status: 'queued',
    status_reason: null,
    priority: 50,
    estimated_cost_usd_micros: null,
  });
  announceAndWaitForAck(11);

  // Step 12
  const secondTask = insertTask(db, {
    project_id: project.id,
    phase_id: phase.id,
    parent_task_id: null,
    title: 'Do the other thing',
    body: 'Depends on the first thing',
    acceptance_criteria: ['it builds'],
    required_skills: [],
    deliverable_type: 'code',
    assignee_employee_id: null,
    excluded_employees: [],
    status: 'queued',
    status_reason: null,
    priority: 50,
    estimated_cost_usd_micros: null,
  });
  insertTaskDep(db, secondTask.id, task.id);
  announceAndWaitForAck(12);

  // Step 13
  const worktree = insertWorktree(db, {
    project_id: project.id,
    path: 'C:\\killtest\\worktrees\\director',
    branch: `bureau/director/${task.display_key}`,
    base_commit: '0000000000000000000000000000000000000000',
    status: 'free',
  });
  announceAndWaitForAck(13);

  // Step 14
  const leaseExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
  acquireWorktreeLease(db, worktree.id, directorEmployeeId, leaseExpiresAt);
  announceAndWaitForAck(14);

  // Step 15: file write only — the exact §11.6 boundary this test exists
  // to prove. Deliberately not using ActivityLog.logEvent(), which would
  // do both halves before this script could announce in between.
  const entry: ActivityLogEntry = {
    seq: 1,
    id: newId(),
    ts: nowIso(),
    actor: 'director',
    type: 'git.lease_acquired',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: directorEmployeeId,
    checkpoint_id: null,
    payload: { worktreeId: worktree.id },
  };
  const fd = openSync(activityLogPath, 'a');
  const line = `${JSON.stringify(entry)}\n`;
  appendFileSync(fd, line);
  fsyncSync(fd);
  closeSync(fd);
  announceAndWaitForAck(15);

  // Step 16: the mirror insert — the other half.
  insertMirrorRow(db, entry, nowIso());
  announceAndWaitForAck(16);

  // Step 17
  const conversation = insertConversation(db, {
    company_id: companyId,
    project_id: project.id,
    title: 'Kill point chat',
    director_session_id: null,
    summary: null,
    director_state: null,
    director_state_data: null,
    status: 'active',
  });
  insertConversationMessage(db, {
    conversation_id: conversation.id,
    project_id: project.id,
    author: 'director',
    kind: 'text',
    body: 'partial reply in progress...',
    payload: null,
    checkpoint_id: null,
    status: 'streaming',
    seq: 1,
    read_at: null,
  });
  announceAndWaitForAck(17);

  // Step 18
  setTaskStatus(db, task.id, 'running');
  announceAndWaitForAck(18);

  // Step 19
  setSetting(db, 'general.notifications', false);
  announceAndWaitForAck(19);

  // Step 20
  insertUsage(db, {
    employee_id: directorEmployeeId,
    task_id: task.id,
    engine: 'claude-code',
    model: 'balanced',
    tokens_in: 1000,
    tokens_out: 500,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost_usd_micros: 15_000,
    turn_index: 1,
    source: 'turn',
  });
  announceAndWaitForAck(20);

  // Stay alive — the parent controls exactly when this process dies.
  setInterval(() => {}, 60_000);
}

void main();
