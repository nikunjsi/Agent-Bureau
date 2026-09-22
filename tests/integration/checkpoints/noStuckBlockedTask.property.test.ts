import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import {
  cancelCheckpoint,
  insertCheckpoint,
  listPendingCheckpoints,
} from '../../../src/main/db/repositories/checkpoints';
import { answerCheckpoint } from '../../../src/main/checkpoints/answerCheckpoint';
import { resolveExpiredCheckpoints } from '../../../src/main/checkpoints/checkpointsTick';
import { blockTaskForCheckpoint } from '../../../src/main/checkpoints/taskBlocking';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const DAY_MS = 24 * 60 * 60 * 1000;
const TASKS = 3;

type Op =
  | { kind: 'raise'; task: number; withDefault: boolean; blocks: boolean }
  | { kind: 'raisePermission'; task: number }
  | { kind: 'answer'; pick: number }
  | { kind: 'systemResolve'; pick: number }
  | { kind: 'expireInsideGrace' }
  | { kind: 'expirePastGrace' }
  | { kind: 'restart' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('raise' as const),
    task: fc.nat({ max: TASKS - 1 }),
    withDefault: fc.boolean(),
    blocks: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('raisePermission' as const), task: fc.nat({ max: TASKS - 1 }) }),
  fc.record({ kind: fc.constant('answer' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('systemResolve' as const), pick: fc.nat() }),
  fc.constant({ kind: 'expireInsideGrace' as const }),
  fc.constant({ kind: 'expirePastGrace' as const }),
  fc.constant({ kind: 'restart' as const }),
);

/**
 * T-1 (§19, checkpoint state machine): **no sequence of events leaves a task
 * blocked with no pending checkpoint.** §19 calls this "the deadlock that would
 * make the product feel broken", and M11 is what drives this machine.
 *
 * Generated sequences run against the real functions: `insertCheckpoint` and
 * `blockTaskForCheckpoint` (the producers' path), `answerCheckpoint` from the
 * user and from the system, the real timeout sweep inside and past the
 * post-restart grace, and a restart (reconcile cancels pending permission
 * checkpoints, which never block a task). After every step: a task blocked on
 * a checkpoint (`status_reason = checkpoint:<id>`) has that checkpoint pending.
 *
 * Scope, stated: tasks blocked for reasons that are not a checkpoint
 * (\`ended_without_report\`, \`app_restart\`, an agent's own \`bureau_task_blocked\`)
 * have no checkpoint by design and are the Director's to act on (M11). Message
 * delivery changes no task state, so it is not generated.
 */
describe('T-1: no task is left blocked without a pending checkpoint (property)', () => {
  /**
   * One migrated, settings-seeded database, built once per test and copied
   * for every generated run. Each run still starts from a fresh file with
   * the real schema; what this saves is re-running all ten migrations, each
   * behind an online backup, sixty times over. That cost proved nothing
   * here (migrations have their own tests), and on the hosted CI runner,
   * where every fsync is roughly ten times slower than on a dev box, it
   * pushed this test past its timeout (run 35724599688).
   */
  async function makeTemplate(tmpDir: string): Promise<string> {
    const dir = path.join(tmpDir, 'template');
    const dbPath = path.join(dir, 'bureau.db');
    mkdirSync(dir, { recursive: true });
    const templateDb = openConnection(dbPath);
    try {
      await runMigrations({
        db: templateDb,
        dbPath,
        migrationsDir: REAL_MIGRATIONS_DIR,
        backupsDir: path.join(dir, 'backups'),
      });
      seedSettingsDefaults(templateDb);
      templateDb.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      templateDb.close();
    }
    return dbPath;
  }

  function freshDb(tmpDir: string, templatePath: string, run: number) {
    const dir = path.join(tmpDir, `run-${run}`);
    const dbPath = path.join(dir, 'bureau.db');
    mkdirSync(dir, { recursive: true });
    copyFileSync(templatePath, dbPath);
    const db = openConnection(dbPath);
    const activityLog = ActivityLog.open(path.join(dir, 'activity.jsonl'), db);
    const project = seedProject(db);
    const employee = seedEmployee(db);
    const tasks = Array.from({ length: TASKS }, (_, i) =>
      seedTask(db, {
        project_id: project.id,
        title: `Task ${i}`,
        status: 'running',
        assignee_employee_id: employee.id,
      }),
    );
    return { db, activityLog, project, employee, tasks };
  }

  function violations(db: Database.Database): string[] {
    const rows = db
      .prepare(
        "SELECT t.id, t.status_reason, c.status AS cp_status FROM tasks t LEFT JOIN checkpoints c ON t.status_reason = 'checkpoint:' || c.id WHERE t.status = 'blocked' AND t.status_reason LIKE 'checkpoint:%'",
      )
      .all() as Array<{ id: string; status_reason: string; cp_status: string | null }>;
    return rows
      .filter((row) => row.cp_status !== 'pending')
      .map(
        (row) => `task ${row.id} blocked on ${row.status_reason} (${row.cp_status ?? 'missing'})`,
      );
  }

  it('holds after every step of every generated sequence', async () => {
    // Everything this test creates lives under its own directory and is
    // removed in its own `finally`, after every handle is closed. It used
    // to be a shared afterEach, which a timed-out body raced: the body kept
    // running into the next test's directory and left a bureau.db open
    // (run 35724599688, EPERM on both tests).
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-t1-'));
    try {
      const templatePath = await makeTemplate(tmpDir);
      let run = 0;
      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), async (ops) => {
          const { db, activityLog, project, employee, tasks } = freshDb(
            tmpDir,
            templatePath,
            run++,
          );
          const deps = { db, activityLog, baseDir: tmpDir };
          const startedWall = Date.now();
          let counter = 0;
          try {
            for (const op of ops) {
              const pending = listPendingCheckpoints(db).filter((c) => c.type !== 'permission');
              switch (op.kind) {
                case 'raise': {
                  const task = tasks[op.task]!;
                  const checkpoint = insertCheckpoint(db, activityLog, {
                    project_id: project.id,
                    task_id: task.id,
                    employee_id: employee.id,
                    type: 'decision',
                    urgency: 'blocking',
                    title: `Decision ${counter++}`,
                    context: 'Generated.',
                    options: [
                      // X-9: the two go together. A default names a reversible
                      // option, and a reversible option must be the default —
                      // so the generator's "no default" arm states neither.
                      {
                        id: 'safe',
                        label: 'Safe',
                        consequence: 'Nothing changes.',
                        ...(op.withDefault ? { reversible: true } : {}),
                      },
                      { id: 'bold', label: 'Bold', consequence: 'Something changes.' },
                    ],
                    default_action: op.withDefault ? 'safe' : null,
                  });
                  if (op.blocks) {
                    blockTaskForCheckpoint(db, activityLog, {
                      taskId: task.id,
                      checkpointId: checkpoint.id,
                      detail: 'generated',
                      employeeId: employee.id,
                    });
                  }
                  break;
                }
                case 'raisePermission':
                  insertCheckpoint(db, activityLog, {
                    project_id: project.id,
                    task_id: tasks[op.task]!.id,
                    employee_id: employee.id,
                    type: 'permission',
                    tool_call_id: `call-${counter}`,
                    tool_name: 'Bash',
                    urgency: 'blocking',
                    title: `Permission ${counter++}`,
                    context: 'Generated.',
                    options: [
                      { id: 'allow', label: 'Allow', consequence: 'The tool call runs.' },
                      {
                        id: 'deny',
                        label: 'Deny',
                        consequence: 'The tool call does not run.',
                        reversible: true,
                      },
                    ],
                    default_action: 'deny',
                  });
                  break;
                case 'answer':
                case 'systemResolve': {
                  if (pending.length === 0) break;
                  const target = pending[op.pick % pending.length]!;
                  answerCheckpoint(deps, {
                    checkpointId: target.id,
                    optionId: 'safe',
                    source: op.kind === 'answer' ? 'user' : 'system',
                    ...(op.kind === 'systemResolve' ? { systemReason: 'generated' } : {}),
                  });
                  break;
                }
                case 'expireInsideGrace':
                  resolveExpiredCheckpoints(deps, {
                    appStartedAtMs: startedWall,
                    nowMs: startedWall + 30 * DAY_MS,
                    uptimeMs: 60_000,
                  });
                  break;
                case 'expirePastGrace':
                  resolveExpiredCheckpoints(deps, {
                    appStartedAtMs: startedWall,
                    nowMs: startedWall + 30 * DAY_MS,
                    uptimeMs: 60 * 60_000,
                  });
                  break;
                case 'restart':
                  for (const cp of listPendingCheckpoints(db).filter(
                    (c) => c.type === 'permission',
                  )) {
                    cancelCheckpoint(db, cp.id, 'system:app_restart');
                  }
                  break;
              }
              const broken = violations(db);
              if (broken.length > 0) {
                throw new Error(`after ${op.kind}: ${broken.join('; ')}`);
              }
            }
          } finally {
            activityLog.close();
            db.close();
          }
        }),
        { numRuns: 60 },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('the invariant query is not vacuous: a hand-made stuck task is reported', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-t1-'));
    try {
      const { db, activityLog, tasks } = freshDb(tmpDir, await makeTemplate(tmpDir), 0);
      try {
        db.prepare(
          "UPDATE tasks SET status = 'blocked', status_reason = 'checkpoint:nope' WHERE id = ?",
        ).run(tasks[0]!.id);
        expect(violations(db)).toHaveLength(1);
      } finally {
        activityLog.close();
        db.close();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
