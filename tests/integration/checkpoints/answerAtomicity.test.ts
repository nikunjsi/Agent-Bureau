import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertCheckpoint, getCheckpointById } from '../../../src/main/db/repositories/checkpoints';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { blockTaskForCheckpoint } from '../../../src/main/checkpoints/taskBlocking';
import { answerCheckpoint } from '../../../src/main/checkpoints/answerCheckpoint';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * X-12 / §9.7: **"a producer inserts its message and updates task state in one
 * `BEGIN IMMEDIATE` transaction."**
 *
 * `answerCheckpoint` did three writes in a row and committed each on its own:
 * the answer (a compare-and-swap), the task unblock, and the outbox message
 * the employee is waiting for. A crash — or any failure — between the second
 * and the third left the pair torn in the worst direction: a task marked
 * runnable, and nothing in the outbox to tell the employee what was decided.
 * The employee would take its next turn having lost the answer, permanently,
 * because the checkpoint was already `answered` and nothing would send it
 * again.
 *
 * ## Why a failed write stands in for a kill here
 *
 * `killPoints.test.ts` kills a real process between scripted steps, and that
 * is the right tool when the boundary it must land on is *between two calls*.
 * It cannot land inside one, and after this change there is no inside to land
 * in: the three writes are one transaction, so SQLite's own atomicity is what
 * the kill would be testing. What can still be driven is the other half of the
 * same guarantee — a write that fails part-way — and SQLite rolls back a
 * transaction identically whether the process died or the statement threw.
 * The trigger below is the failure; the assertions are about what survives it.
 */
describe('answering is one transaction: the unblock and the message, or neither (X-12)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let deps: { db: Database.Database; activityLog: ActivityLog; baseDir: string };

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-answer-atomic-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    deps = { db, activityLog, baseDir: tmpDir };
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function blockedOnACheckpoint(): { checkpointId: string; taskId: string } {
    const project = seedProject(db);
    const employee = seedEmployee(db);
    const task = seedTask(db, {
      project_id: project.id,
      status: 'running',
      assignee_employee_id: employee.id,
    });
    const checkpoint = insertCheckpoint(db, activityLog, {
      project_id: project.id,
      task_id: task.id,
      employee_id: employee.id,
      type: 'decision',
      urgency: 'blocking',
      title: 'Skip the rows the importer cannot read?',
      context: 'Three rows in the sample file are unreadable.',
      options: [
        { id: 'skip', label: 'Skip them', consequence: 'The import finishes without those rows.' },
        {
          id: 'stop',
          label: 'Stop and wait',
          consequence: 'Nothing is imported until you say otherwise.',
          reversible: true,
        },
      ],
      default_action: 'stop',
    });
    blockTaskForCheckpoint(db, activityLog, {
      taskId: task.id,
      checkpointId: checkpoint.id,
      detail: 'waiting on a decision',
      employeeId: employee.id,
    });
    return { checkpointId: checkpoint.id, taskId: task.id };
  }

  const countMessages = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  const countEvents = (type: string): number =>
    (
      db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(type) as {
        n: number;
      }
    ).n;

  it('lands both writes on the ordinary path', () => {
    const { checkpointId, taskId } = blockedOnACheckpoint();

    const result = answerCheckpoint(deps, { checkpointId, optionId: 'skip', source: 'user' });

    expect(result).toMatchObject({ ok: true, unblockedTaskId: taskId });
    expect(getTaskById(db, taskId)?.status).toBe('assigned');
    expect(countMessages()).toBe(1);
  });

  it('rolls the unblock back when the message cannot be written', () => {
    const { checkpointId, taskId } = blockedOnACheckpoint();
    // The failure. Anything that makes the outbox write fail would do —
    // a disk error, a constraint, a killed process — and this is the one
    // a test can cause exactly, on the real statement, at the real moment.
    db.exec(
      "CREATE TRIGGER outbox_is_full BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );

    expect(() =>
      answerCheckpoint(deps, { checkpointId, optionId: 'skip', source: 'user' }),
    ).toThrow(/disk full/);

    // Nothing partial survived: the task is still blocked ON THIS
    // checkpoint, and the checkpoint is still pending, so the user can
    // answer it again and the employee is still waiting rather than
    // running with an answer nobody delivered.
    const task = getTaskById(db, taskId);
    expect(task?.status).toBe('blocked');
    expect(task?.status_reason).toBe(`checkpoint:${checkpointId}`);
    expect(getCheckpointById(db, checkpointId)?.status).toBe('pending');
    expect(countMessages()).toBe(0);
  });

  it('emits no event for a write that rolled back', () => {
    // Invariant #3 is "committed, then exactly one event" — an event for a
    // state change that did not survive is the same lie as a missing one,
    // and the activity log is what a user reads to find out what happened.
    const { checkpointId } = blockedOnACheckpoint();
    db.exec(
      "CREATE TRIGGER outbox_is_full BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );

    expect(() =>
      answerCheckpoint(deps, { checkpointId, optionId: 'skip', source: 'user' }),
    ).toThrow();

    expect(countEvents('checkpoint.answered')).toBe(0);
    expect(countEvents('task.unblocked')).toBe(0);
    expect(countEvents('message.sent')).toBe(0);
  });
});
