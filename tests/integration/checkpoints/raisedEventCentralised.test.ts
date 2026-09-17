import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { seedEmployee, seedProject } from '../../helpers/dbFixtures';

/**
 * **AUDIT finding #23**, closed.
 *
 * The audit: "Checkpoint rows created by the budget and breaker paths
 * don't emit a `checkpoint.raised`-shaped event — they emit a
 * differently-typed triggering-condition event (`employee.budget_exceeded`,
 * etc.) instead... A consumer filtering on `checkpoint.raised` would miss
 * these." Its suggested fix offered two options: "emit `checkpoint.raised`
 * uniformly, **or** centralize it inside `insertCheckpoint`."
 *
 * The second was taken. The first is four more call sites, each of which a
 * fifth creation path can forget to copy — which is how the finding came to
 * exist in the first place.
 *
 * So this file does not enumerate the five callers, because enumerating
 * them would be a test that needs updating every time a sixth appears, and
 * would say nothing about one that never gets added to the list. It tests
 * the property that makes enumeration unnecessary: **`insertCheckpoint` is
 * the only way to create a checkpoint, and it always emits.**
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const SRC_ROOT = path.resolve('src');

describe('checkpoint.raised is emitted by every creation path (AUDIT #23)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-cp-raised-'));
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
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function raisedEvents(): { actor: string; checkpoint_id: string; payload: string }[] {
    return db
      .prepare(
        "SELECT actor, checkpoint_id, payload FROM events WHERE type = 'checkpoint.raised' ORDER BY seq",
      )
      .all() as { actor: string; checkpoint_id: string; payload: string }[];
  }

  it('emits exactly one checkpoint.raised, carrying the row it describes', () => {
    const project = seedProject(db);
    const employee = seedEmployee(db);

    const cp = insertCheckpoint(db, activityLog, {
      project_id: project.id,
      employee_id: employee.id,
      type: 'decision',
      urgency: 'blocking',
      title: 'Should we optimise for read speed?',
      context: 'The report screen is slow, and the fix duplicates some data.',
      options: [
        {
          id: 'yes',
          label: 'Optimise',
          consequence: 'Reports load fast; some data is duplicated.',
        },
        {
          id: 'no',
          label: 'Leave it',
          consequence: 'Nothing changes; reports stay slow.',
          reversible: true,
        },
      ],
      default_action: 'no',
    });

    const events = raisedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.checkpoint_id).toBe(cp.id);
    expect(events[0]?.actor).toBe(`employee:${employee.id}`);

    const payload = JSON.parse(events[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload['type']).toBe('decision');
    expect(payload['urgency']).toBe('blocking');
    expect(payload['expiresAt']).toBe(cp.expires_at);
  });

  it('emits for a system-raised checkpoint too, with actor "system" rather than employee:null', () => {
    // The budget, quota and merge-conflict paths all create rows with no
    // employee behind them. Those are precisely the ones the audit found
    // emitting nothing.
    insertCheckpoint(db, activityLog, {
      project_id: seedProject(db).id,
      type: 'approval',
      urgency: 'blocking',
      title: 'Budget exhausted — no funds left to work with',
      context: "This project's budget has been fully spent, including the reserve.",
      options: [
        {
          id: 'raise',
          label: 'Raise the budget',
          consequence: 'Work continues immediately at the new limit.',
        },
        {
          id: 'cut',
          label: 'Cut scope',
          consequence: 'Work stays paused until the limit resets or you raise it.',
        },
      ],
    });

    const events = raisedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe('system');
  });

  it('the event is written to the activity log FILE, not only the events mirror', () => {
    // §11.6: `activity.jsonl` is the source of truth and the `events`
    // table is its mirror. A consumer filtering on `checkpoint.raised`
    // reads whichever it has; both must have it.
    insertCheckpoint(db, activityLog, {
      type: 'information',
      urgency: 'whenever',
      title: 'Free quota exhausted',
      context: 'This engine has used its free allowance for now.',
      options: null,
    });

    const lines = readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string });
    expect(lines.filter((entry) => entry.type === 'checkpoint.raised')).toHaveLength(1);
  });

  /**
   * The structural half, and the reason this finding cannot come back.
   *
   * A behavioural test can only check the paths it knows about. This
   * checks the property that makes new paths safe by construction: nothing
   * in `src/` writes to the `checkpoints` table except the one repository
   * function that emits the event.
   *
   * Standing rule 1 applies — this must not re-implement what it verifies,
   * so it reads the real source tree rather than a list maintained here.
   */
  it('no code outside the repository INSERTs into checkpoints — so no path can skip the event', () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        // The one door itself.
        if (full.endsWith(path.join('db', 'repositories', 'checkpoints.ts'))) continue;

        const source = readFileSync(full, 'utf8');
        if (/INSERT\s+INTO\s+checkpoints\b/i.test(source)) {
          offenders.push(path.relative(SRC_ROOT, full));
        }
      }
    };
    walk(SRC_ROOT);

    expect(offenders).toEqual([]);
  });
});
