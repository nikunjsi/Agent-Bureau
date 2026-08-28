/**
 * The worker driven by
 * tests/integration/workspace/gitProtectionLayer4.test.ts's crash-window
 * proofs (M5 part 2, D4). Mirrors `worktreeKillWorker.ts`'s own technique
 * exactly — applied to the two new windows `commitTaskWork` introduces:
 *
 *   1. Between the durable intent marker (`pending_commit_task_id`)
 *      being written and the real `git commit` running.
 *   2. Between the real `git commit` landing and the atomic
 *      `base_commit`-update-plus-marker-clear UPDATE running.
 *
 * Both use the real production functions
 * (`setWorktreePendingCommitTask`/`stageAll`/`commitWithIdentity`/
 * `setWorktreeBaseCommitAndClearPendingCommit`) in the exact order
 * `employeeCommit.ts`'s own `commitTaskWork` uses — a hand-instrumented
 * *sequence* of those same real calls, not a reimplementation, for the
 * same reason `worktreeKillWorker.ts`'s own doc comment gives.
 */
import { readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { nowIso } from '../../../src/shared/models/ids';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertTask } from '../../../src/main/db/repositories/tasks';
import { setWorktreePendingCommitTask, setWorktreeBaseCommitAndClearPendingCommit } from '../../../src/main/db/repositories/worktrees';
import { registerProjectWorkspace, hireEmployeeWorktree, assignTaskToWorktree, resolveDefaultIntegrationRef } from '../../../src/main/workspace/employeeWorktree';
import { getCheckedOutBranch, stageAll, commitWithIdentity } from '../../../src/main/workspace/gitWorktree';

function announceAndWaitForAck(step: number): void {
  process.stdout.write(`STEP_DONE ${step}\n`);
  const buffer = Buffer.alloc(1);
  try {
    readSync(0, buffer, 0, 1, null);
  } catch {
    // stdin closed (the parent killed us mid-read) — nothing to do.
  }
}

async function main(): Promise<void> {
  const dbPath = process.env['BUREAU_COMMITKILLTEST_DB_PATH'];
  const activityLogPath = process.env['BUREAU_COMMITKILLTEST_ACTIVITY_LOG_PATH'];
  const migrationsDir = process.env['BUREAU_COMMITKILLTEST_MIGRATIONS_DIR'];
  const backupsDir = process.env['BUREAU_COMMITKILLTEST_BACKUPS_DIR'];
  const repoPath = process.env['BUREAU_COMMITKILLTEST_REPO_PATH'];
  const companyHomePath = process.env['BUREAU_COMMITKILLTEST_HOME_PATH'];
  if (!dbPath || !activityLogPath || !migrationsDir || !backupsDir || !repoPath || !companyHomePath) {
    throw new Error('commitKillWorker: missing required BUREAU_COMMITKILLTEST_* env vars');
  }

  const db = openConnection(dbPath);
  await runMigrations({ db, dbPath, migrationsDir, backupsDir });
  const activityLog = ActivityLog.open(activityLogPath, db);
  const now = nowIso();

  const departmentId = 'dept1'.padEnd(26, '0');
  const roleId = 'role1'.padEnd(26, '0');
  const employeeId = 'emp1'.padEnd(26, '0');

  db.prepare('INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(
    departmentId, 'engineering', 'Engineering', '{}', now, now,
  );
  db.prepare(
    `INSERT INTO roles (id,key,department_key,pack_id,version,title,description,system_prompt_path,skills,deliverable_types,engine_preference,tools_allow,tools_deny,memory_scopes,autonomy_default,sprite_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(roleId, 'developer', 'engineering', 'core', '1.0.0', 'Dev', 'd', 'p.md', '[]', '[]', '[]', '[]', '[]', '[]', 'guided', 'dev', now, now);
  db.prepare(
    'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(employeeId, 'Ravi', 'core:developer', 0, 0, 'a', 'off', 'claude-code', 'guided', now, now, now);
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as { id: string; name: string; role_key: string; engine: string };

  let project = insertProject(db, { name: 'Commit Kill Window Project', path: repoPath, kind: 'software' });
  await registerProjectWorkspace(db, project);
  const initialBranch = await getCheckedOutBranch(repoPath);
  db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(initialBranch, project.id);
  project = { ...project, base_ref: initialBranch, repo_initialised: true };

  let worktree = await hireEmployeeWorktree({ db, activityLog, project, employee: employee as never, companyHomePath });

  const task = insertTask(db, {
    project_id: project.id,
    title: 'Commit kill window task',
    body: 'Real work for the commit-path crash-window proof.',
    acceptance_criteria: ['done'],
    status: 'review',
  });

  worktree = await assignTaskToWorktree({
    db,
    activityLog,
    project,
    employee: employee as never,
    worktree,
    task,
    integrationRef: resolveDefaultIntegrationRef(project),
  });

  // A real file change to commit — otherwise `git commit` has nothing
  // to do and step 5 would be a no-op, defeating the whole point of
  // pinning a kill between it and step 6.
  writeFileSync(path.join(worktree.path, 'work.txt'), 'real work done by the employee\n', 'utf8');

  // --- commitTaskWork, hand-instrumented around windows 1 and 2 ---
  // (HEAD-reconciliation and validators are skipped here on purpose —
  // this worker exists to pin the two *new* windows commitTaskWork's
  // steps 4-6 introduce, not to re-prove steps 2-3, which
  // commitPath.test.ts and this same test file's S6 case already cover.)

  // Step 4: write the durable intent marker — BEFORE the side effect.
  setWorktreePendingCommitTask(db, worktree.id, task.id);

  // Window 1: marker written, `git commit` has not run yet. A kill
  // withheld here must reconcile to "nothing to converge, clear the
  // stale marker."
  announceAndWaitForAck(1);

  // Step 5: the real side effect.
  await stageAll(project.path, worktree.path);
  const commitSha = await commitWithIdentity(project.path, worktree.path, 'bureau(ravi): commit kill window work', {
    name: 'Ravi (Bureau)',
    email: 'ravi@bureau.local',
  });

  // Window 2: the commit landed for real; base_commit/marker have not
  // been updated yet. A kill withheld here must reconcile to "HEAD
  // moved past base_commit — converge, don't flag as foreign."
  announceAndWaitForAck(2);

  // Step 6: one atomic UPDATE.
  setWorktreeBaseCommitAndClearPendingCommit(db, worktree.id, commitSha);

  activityLog.logEvent({
    actor: 'system',
    type: 'git.committed',
    severity: 'info',
    project_id: project.id,
    task_id: task.id,
    employee_id: employeeId,
    checkpoint_id: null,
    payload: { worktreeId: worktree.id, commitSha },
  });

  // Stay alive — the parent controls exactly when this process dies.
  setInterval(() => {}, 60_000);
}

void main();
