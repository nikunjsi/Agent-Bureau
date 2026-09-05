import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import {
  registerProjectWorkspace,
  hireEmployeeWorktree,
  assignTaskToWorktree,
  createPhaseIntegrationBranch,
  resolveDefaultIntegrationRef,
} from '../../../src/main/workspace/employeeWorktree';
import { getCheckedOutBranch } from '../../../src/main/workspace/gitWorktree';
import { commitTaskWork } from '../../../src/main/workspace/employeeCommit';
import { mergeAcceptedTask } from '../../../src/main/workspace/integrationMerge';
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import type { Project } from '../../../src/shared/models/project';
import type { Employee } from '../../../src/shared/models/employee';
import type { Validator } from '../../../src/main/workspace/validators';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

const TRIVIAL_VALIDATORS: Validator[] = [
  { name: 'secret-scan', run: async () => ({ name: 'secret-scan', passed: true, output: 'no secrets detected' }) },
];

describe('§28 M5 item 9 — the soak: 100 lease/commit/merge cycles', () => {
  let dbDir: string;
  let repoPath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-soak-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-soak-repo-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-soak-home-'));
    const dbPath = path.join(dbDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(dbDir, 'backups') });
    activityLog = ActivityLog.open(path.join(dbDir, 'activity.jsonl'), db);
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(companyHomePath, { recursive: true, force: true });
  });

  async function setUpRegisteredProject(): Promise<Project> {
    const project = seedProject(db, { path: repoPath });
    await registerProjectWorkspace(db, project);
    const initialBranch = await getCheckedOutBranch(repoPath);
    db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(initialBranch, project.id);
    return getProjectById(db, project.id) as Project;
  }

  it(
    '3 employees, ~100 total commit+merge cycles, real concurrency, zero conflicts by construction, zero index.lock failures, no cross-worktree contamination',
    async () => {
      const project = await setUpRegisteredProject();
      const { branch: integrationBranch } = await createPhaseIntegrationBranch(project.path, 1, project.base_ref);

      const employeeNames = ['Ravi', 'Meera', 'Dan'];
      const CYCLES_PER_EMPLOYEE = 34; // 3 x 34 = 102, comfortably >= 100
      const employees: Record<string, Employee> = {};

      for (const name of employeeNames) {
        const employee = seedEmployee(db, { name });
        employees[name] = employee;
        // One real worktree per employee, created once — reused across
        // every one of that employee's cycles, exactly like a real
        // session would (not re-hired per task).
        await hireEmployeeWorktree({ db, activityLog, project, employee, companyHomePath });
      }

      async function runCyclesFor(name: string): Promise<number> {
        const employee = employees[name] as Employee;
        let cyclesCommitted = 0;
        for (let cycle = 0; cycle < CYCLES_PER_EMPLOYEE; cycle += 1) {
          // Re-fetch fresh each cycle — the previous cycle's merge/assign
          // updated this row.
          const employeeRow = db.prepare('SELECT worktree_id FROM employees WHERE id = ?').get(employee.id) as { worktree_id: string };
          let worktree = getWorktreeById(db, employeeRow.worktree_id)!;
          const task = seedTask(db, { project_id: project.id, title: `${name} cycle ${cycle}`, status: 'review' });

          worktree = await assignTaskToWorktree({ db, activityLog, project, employee, worktree, task, integrationRef: integrationBranch });

          // Every cycle writes to this employee's OWN dedicated file,
          // and only that file — the cross-worktree-contamination check.
          writeFileSync(path.join(worktree.path, `${name.toLowerCase()}.txt`), `${name} cycle ${cycle}\n`, 'utf8');

          const commitResult = await commitTaskWork({ db, activityLog, project, employee, worktree, task, validators: TRIVIAL_VALIDATORS });
          if (commitResult.outcome !== 'committed') {
            throw new Error(`${name} cycle ${cycle}: commit did not succeed: ${JSON.stringify(commitResult)}`);
          }

          const freshWorktree = getWorktreeById(db, worktree.id)!;
          const mergeResult = await mergeAcceptedTask({ db, activityLog, project, task, worktree: freshWorktree, integrationBranch });
          if (mergeResult.outcome !== 'merged') {
            throw new Error(`${name} cycle ${cycle}: merge did not succeed (a real conflict on disjoint files would be a real bug): ${JSON.stringify(mergeResult)}`);
          }
          cyclesCommitted += 1;
        }
        return cyclesCommitted;
      }

      // Real concurrency: all three employees' entire cycle sequences run
      // interleaved, not one after another.
      const results = await Promise.all(employeeNames.map((name) => runCyclesFor(name)));
      const totalCycles = results.reduce((a, b) => a + b, 0);

      expect(totalCycles).toBeGreaterThanOrEqual(100);

      // Real command, real output.
      const logGraphRaw = execFileSync('git', ['log', '--graph', '--oneline', integrationBranch], { cwd: project.path, encoding: 'utf8' });
       
      console.log(`--- git log --graph --oneline ${integrationBranch} (tail) ---\n${logGraphRaw.split('\n').slice(0, 20).join('\n')}\n... (${logGraphRaw.split('\n').length} lines total)`);
      expect(logGraphRaw).not.toMatch(/CONFLICT|<<<<<<</);

      // execFileSync itself throws on a nonzero exit — git fsck exiting 0
      // is the real "no corruption" signal. "dangling commit" lines are
      // git's normal report of unreferenced-but-valid objects, not a
      // problem: exactly what a CAS retry losing a race legitimately
      // leaves behind (an abandoned, still-perfectly-valid merge-commit
      // object, superseded by whichever attempt actually won the ref
      // update) — a high dangling-commit count here is a *sign* real
      // concurrent racing happened throughout the soak, not a defect.
      // What must never appear is an actual problem indicator.
      const fsckRaw = execFileSync('git', ['fsck', '--full'], { cwd: project.path, encoding: 'utf8' });
       
      console.log(
        `--- git fsck --full (${fsckRaw.split('\n').filter((l) => l.trim().length > 0).length} lines, dangling objects expected from CAS-retry losers) ---`,
      );
      expect(fsckRaw).not.toMatch(/error|missing|broken|corrupt/i);

      // Cross-worktree contamination check: every commit this soak made
      // touched exactly one file, and it's the right employee's file.
      const commitFilesRaw = execFileSync(
        'git',
        ['log', '--name-only', '--pretty=format:>>>%an', integrationBranch],
        { cwd: project.path, encoding: 'utf8' },
      );
      const blocks = commitFilesRaw.split('>>>').filter((b) => b.trim().length > 0);
      let contamination = 0;
      for (const block of blocks) {
        const lines = block.trim().split('\n').filter((l) => l.trim().length > 0);
        const author = lines[0] ?? '';
        const files = lines.slice(1);
        if (files.length === 0) continue; // the merge commits themselves list no direct file changes here
        const authorName = author.split(' ')[0]?.toLowerCase() ?? '';
        for (const file of files) {
          if (!file.toLowerCase().startsWith(authorName)) contamination += 1;
        }
      }
      expect(contamination, 'every real commit must touch only its own author\'s file').toBe(0);

      // No index.lock failure ever surfaced as a real test failure — the
      // whole soak ran to completion above, which is itself the proof;
      // this is a belt-and-suspenders explicit check of the activity log
      // for any git-layer error event.
      const securityEvents = db.prepare("SELECT COUNT(*) as n FROM events WHERE severity = 'security'").get() as { n: number };
      expect(securityEvents.n, 'no false-positive security events during 100+ real concurrent cycles').toBe(0);
    },
    // ~900 real git subprocess spawns (102 cycles x ~8-9 spawns each) —
    // genuinely slow on Windows purely from OS process-creation overhead.
    //
    // AUDIT #15, now backed by a real profiling run rather than
    // inspection. Measured on this machine, 2026-09-05, with nothing else
    // running: **348,776ms** — it PASSES, comfortably inside the old
    // 480_000 limit. The three consecutive "timed out at 480s" sessions
    // were not the test being inherently too slow; they were a ~27%
    // margin being eaten by concurrent load (the audit's own run had a
    // mutation-testing subagent going in another worktree throughout, and
    // said so).
    //
    // So the fix is headroom, not a faster test: ~2.5x the measured
    // unloaded time. A soak that only passes on an idle machine is a soak
    // that fails for the next person, and a flaky gate teaches people to
    // ignore it. M15 inherits this test as its 100-task soak — that is
    // the reason to make the budget honest here rather than re-diagnose
    // it a fourth time.
    900_000,
  );

  it(
    'chaos row 13: a real second git process holds the worktree lock — the bounded retry recovers a real external collision',
    async () => {
      const project = await setUpRegisteredProject();
      const employee = seedEmployee(db, { name: 'Ravi' });
      let worktree = await hireEmployeeWorktree({ db, activityLog, project, employee, companyHomePath });
      const task = seedTask(db, { project_id: project.id, title: 'Lock contention', status: 'review' });
      worktree = await assignTaskToWorktree({
        db,
        activityLog,
        project,
        employee,
        worktree,
        task,
        integrationRef: resolveDefaultIntegrationRef(project),
      });
      writeFileSync(path.join(worktree.path, 'work.txt'), 'real work\n', 'utf8');

      // The real, resolved path to *this worktree's own* index file —
      // never guessed (worktrees keep a separate index under the main
      // repo's .git/worktrees/<name>/, verified empirically during M5
      // part 2 planning, not assumed from general git knowledge).
      const indexPath = execFileSync('git', ['rev-parse', '--git-path', 'index'], { cwd: worktree.path, encoding: 'utf8' }).trim();
      const lockPath = `${indexPath}.lock`;

      // A real lock file exists when Bureau's own `git add -A` tries to
      // run — indistinguishable, from git's own perspective, from a
      // second real git process holding it (git doesn't care who
      // created the lock file, only that it's there). Held for 250ms —
      // comfortably inside the retry's own backoff window
      // ([100, 300, 600]ms), so this proves recovery from real
      // contention, not a race that never actually collided.
      writeFileSync(lockPath, '');
      const clearTimer = setTimeout(() => {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // already gone — fine.
        }
      }, 250);

      try {
        const start = Date.now();
        const result = await commitTaskWork({ db, activityLog, project, employee, worktree, task, validators: TRIVIAL_VALIDATORS });
        const elapsedMs = Date.now() - start;
         
        console.log(`--- chaos row 13: commitTaskWork recovered from real lock contention in ${elapsedMs}ms ---`);

        expect(result.outcome).toBe('committed');
        expect(elapsedMs, 'must have actually waited out the retry backoff, not gotten lucky').toBeGreaterThan(90);
      } finally {
        clearTimeout(clearTimer);
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // already gone.
        }
      }
    },
    20_000,
  );
});
