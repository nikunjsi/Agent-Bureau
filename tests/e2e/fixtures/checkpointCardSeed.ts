import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { insertCompany } from '../../../src/main/db/repositories/companies';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { getCheckpointById, insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { seedEmployee, seedRole } from '../../helpers/dbFixtures';
import type { Checkpoint } from '../../../src/shared/models/checkpoint';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

export interface SeededCheckpoint {
  readonly checkpointId: string;
  readonly title: string;
}

/**
 * A real `blocking` checkpoint, written by the production `insertCheckpoint`,
 * and **no chat message**.
 *
 * The missing message is the point (X-11): the app's own surfacing tick has to
 * write the card, or the spec that reads it finds nothing. A seeded card would
 * prove the renderer again, which `chat.spec.ts` already does.
 *
 * **Why not a `permission` checkpoint**, which is what §28's M8 gate names:
 * `reconcile()` cancels every pending `permission` row at startup, on purpose
 * — its hold lived in the previous process's memory, so the question is
 * already over (§9.1, and `reconcile.ts`'s own note). A permission card can
 * therefore only exist inside a live session with a held agent, which a test
 * process cannot create in the packaged app. That half of the gate is
 * `tests/integration/checkpoints/permissionHold.test.ts`.
 */
export async function seedBlockingCheckpoint(userDataDir: string): Promise<SeededCheckpoint> {
  const paths = getDbPaths(userDataDir, REAL_MIGRATIONS_DIR);
  const db = openConnection(paths.dbPath);
  await runMigrations({
    db,
    dbPath: paths.dbPath,
    migrationsDir: REAL_MIGRATIONS_DIR,
    backupsDir: paths.backupsDir,
  });
  seedSettingsDefaults(db);
  const activityLog = ActivityLog.open(paths.activityLogPath, db);

  const company = insertCompany(db, { name: 'Bureau Test Co', home_path: userDataDir });
  insertConversation(db, {
    company_id: company.id,
    project_id: null,
    title: 'Director',
    director_session_id: null,
    summary: null,
    director_state: null,
    director_state_data: null,
    status: 'active',
  });
  const role = seedRole(db);
  const employee = seedEmployee(db, { role_key: role.full_key, name: 'Ravi' });

  const title = 'Ravi is stuck: should the importer skip bad rows?';
  const checkpoint = insertCheckpoint(db, activityLog, {
    employee_id: employee.id,
    type: 'blocker',
    urgency: 'blocking',
    title,
    context:
      'Three of the sample files have rows the importer cannot read, and Ravi has stopped rather than guess.',
    options: [
      {
        id: 'skip',
        label: 'Skip the bad rows and carry on',
        consequence: 'The import finishes; the skipped rows are listed in a report you can check.',
      },
      {
        id: 'stop',
        label: 'Stop and wait for me',
        consequence: 'Nothing is imported until you say otherwise.',
        reversible: true,
      },
    ],
    default_action: 'stop',
  });

  activityLog.close();
  db.close();
  return { checkpointId: checkpoint.id, title };
}

/** How many `checkpoint` chat cards the database holds — 0 before the app
 *  runs, which is what makes the spec's card the app's own work. */
export function countCheckpointCards(userDataDir: string): number {
  const paths = getDbPaths(userDataDir, REAL_MIGRATIONS_DIR);
  const db = openConnection(paths.dbPath);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE kind = 'checkpoint'")
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** Reads the row back after the app has closed, through the real schema. */
export function readCheckpoint(userDataDir: string, id: string): Checkpoint | null {
  const paths = getDbPaths(userDataDir, REAL_MIGRATIONS_DIR);
  const db = openConnection(paths.dbPath);
  try {
    return getCheckpointById(db, id);
  } finally {
    db.close();
  }
}
