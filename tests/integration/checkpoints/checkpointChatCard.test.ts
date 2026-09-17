import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertCompany } from '../../../src/main/db/repositories/companies';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { createPermissionCheckpoint } from '../../../src/main/checkpoints/permissionCheckpoint';
import {
  CheckpointSurfacer,
  type CheckpointNotifier,
} from '../../../src/main/checkpoints/surfacing';
import { seedEmployee, seedProject } from '../../helpers/dbFixtures';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * X-11 / §9.4 surface 1: **the Core writes the chat card.**
 *
 * §9.4 says a pending checkpoint appears in four places, the Director chat
 * first, and `MessageRow.tsx` has rendered a `checkpoint` message since M9 —
 * but nothing in the Core ever wrote one. The only `kind: 'checkpoint'` row in
 * the tree was in an e2e seed fixture, so the card was real and unreachable:
 * a checkpoint raised by a real agent never appeared in the conversation that
 * §9.4 calls the primary surface.
 *
 * Surfacing writes it, for the checkpoints that do not wait for the Director's
 * grouping — `blocking` and every `permission` (§9.3: those are never batched).
 * A checkpoint still inside its batch window is the Director's to group and
 * announce (M11), so nothing is written for it here.
 */
describe('the Core writes a chat card for a checkpoint it surfaces (X-11)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let conversationId: string;
  let projectId: string;
  let employeeId: string;

  const notifier: CheckpointNotifier = {
    isAnyWindowFocused: () => true, // no desktop toast; this test is about chat
    notify: () => {},
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-cp-card-'));
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
    const company = insertCompany(db, { name: 'Test Co', home_path: tmpDir });
    conversationId = insertConversation(db, {
      company_id: company.id,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
      status: 'active',
    }).id;
    projectId = seedProject(db).id;
    employeeId = seedEmployee(db).id;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function surface(): ReturnType<CheckpointSurfacer['surface']> {
    return new CheckpointSurfacer(db, { activityLog }).surface({
      notifier,
      nowMs: Date.now(),
    });
  }

  interface CardRow {
    readonly checkpoint_id: string | null;
    readonly author: string;
    readonly body: string;
  }

  function cards(): CardRow[] {
    return db
      .prepare(
        "SELECT checkpoint_id, author, body FROM conversation_messages WHERE conversation_id = ? AND kind = 'checkpoint' ORDER BY created_at",
      )
      .all(conversationId) as CardRow[];
  }

  function raiseBlockingDecision(title: string): string {
    return insertCheckpoint(db, activityLog, {
      project_id: projectId,
      employee_id: employeeId,
      type: 'decision',
      urgency: 'blocking',
      title,
      context: 'The work cannot continue until you choose.',
      options: [
        { id: 'go', label: 'Go ahead', consequence: 'The change is made.' },
        {
          id: 'wait',
          label: 'Leave it',
          consequence: 'Nothing changes for now.',
          reversible: true,
        },
      ],
      default_action: 'wait',
    }).id;
  }

  it('writes exactly one card, naming the checkpoint, with one event', () => {
    const id = raiseBlockingDecision('Should the report be rewritten?');

    const report = surface();

    expect(report.chatted).toEqual([id]);
    const written = cards();
    expect(written).toHaveLength(1);
    expect(written[0]?.checkpoint_id).toBe(id);
    expect(written[0]?.author).toBe('director');
    expect(written[0]?.body).toContain('Should the report be rewritten?');
    // Invariant #3: one state change, one event.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'chat.message_persisted'").get(),
    ).toEqual({ n: 1 });
  });

  it('does not write a second card on the next tick', () => {
    raiseBlockingDecision('Should the report be rewritten?');
    surface();

    const second = surface();

    expect(second.chatted).toEqual([]);
    expect(cards()).toHaveLength(1);
  });

  it('writes one for a permission checkpoint — the agent is held while it waits', () => {
    const checkpoint = createPermissionCheckpoint(db, activityLog, {
      employeeId,
      projectId,
      callId: 'call-1',
      tool: 'Bash',
      argsPreview: 'npm install express',
      reason: 'Installing a package changes the project.',
      holdMinutes: 30,
    });

    const report = surface();

    expect(report.chatted).toEqual([checkpoint.id]);
    expect(cards()[0]?.checkpoint_id).toBe(checkpoint.id);
  });

  it('writes nothing for a checkpoint still inside its batch window — that one is the Director’s to group', () => {
    insertCheckpoint(db, activityLog, {
      project_id: projectId,
      employee_id: employeeId,
      type: 'decision',
      urgency: 'soon',
      title: 'Which colour for the header?',
      context: 'Both are fine; it is a preference.',
      options: [
        { id: 'blue', label: 'Blue', consequence: 'The header is blue.' },
        { id: 'green', label: 'Green', consequence: 'The header is green.' },
      ],
    });

    const report = surface();

    expect(report.chatted).toEqual([]);
    expect(cards()).toHaveLength(0);
  });
});
