import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import {
  insertConversation,
  getConversationById,
} from '../../../src/main/db/repositories/conversations';
import {
  DIRECTOR_TRANSITIONS,
  InvalidDirectorTransitionError,
  describeDirectorStateForContext,
  getDirectorState,
  transitionDirectorState,
} from '../../../src/main/director/directorState';
import { seedCompany } from '../../helpers/companyFixture';

/**
 * **Appendix A.3, persisted** (M11 row S1-14). The Director's state lives in
 * `conversations.director_state` / `director_state_data`, so "an app restart
 * resumes mid-intake or mid-review rather than starting over". The table of
 * transitions is one table in code, and a transition not in it is refused
 * with nothing written.
 */
describe('the Director state machine (Appendix A.3), persisted', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let conversationId: string;

  async function open(): Promise<void> {
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: path.resolve('src/main/db/migrations'),
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
  }

  function close(): void {
    activityLog.close();
    db.close();
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-director-state-'));
    dbPath = path.join(tmpDir, 'bureau.db');
    await open();
    const companyId = seedCompany(db, path.join(tmpDir, 'home')).id;
    conversationId = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    }).id;
  });

  afterEach(() => {
    close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function eventsOf(type: string): Array<{ payload: Record<string, unknown> }> {
    return (
      db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq').all(type) as Array<{
        payload: string;
      }>
    ).map((row) => ({ payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }

  function forceState(state: string): void {
    db.prepare('UPDATE conversations SET director_state = ? WHERE id = ?').run(
      state,
      conversationId,
    );
  }

  it('a new conversation is IDLE', () => {
    expect(getDirectorState(db, conversationId)).toEqual({ state: 'IDLE', data: {} });
  });

  it('every A.3 transition is allowed, persisted, and emits exactly one event', () => {
    expect(DIRECTOR_TRANSITIONS.length).toBeGreaterThanOrEqual(19);
    for (const transition of DIRECTOR_TRANSITIONS) {
      forceState(transition.from);
      const before = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
      transitionDirectorState(db, activityLog, conversationId, transition.to, {
        trigger: transition.trigger,
      });
      const after = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
      expect(getDirectorState(db, conversationId).state, JSON.stringify(transition)).toBe(
        transition.to,
      );
      expect(after - before, `one event for ${transition.from} → ${transition.to}`).toBe(1);
    }
    // The three transitions §5.2 already has a name for use it.
    expect(eventsOf('director.intake_started').length).toBeGreaterThanOrEqual(1);
    expect(eventsOf('director.escalated').length).toBeGreaterThanOrEqual(1);
    expect(eventsOf('director.replanned').length).toBeGreaterThanOrEqual(1);
    const changed = eventsOf('director.state_changed');
    expect(changed[0]!.payload).toMatchObject({ conversationId, from: 'IDLE', to: 'RESPONDING' });
  });

  it('a transition A.3 does not have is refused, and nothing is written', () => {
    expect(() =>
      transitionDirectorState(db, activityLog, conversationId, 'PLANNING', { trigger: 'skip' }),
    ).toThrow(InvalidDirectorTransitionError);
    expect(getDirectorState(db, conversationId).state).toBe('IDLE');
    expect(getConversationById(db, conversationId)!.director_state).toBeNull();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'director.%'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('a restart resumes mid-intake: the state, its data, and what the next turn is told', async () => {
    transitionDirectorState(db, activityLog, conversationId, 'INTAKE', {
      trigger: 'new_project',
      data: { intakeRound: 2 },
    });

    close();
    await open();

    const resumed = getDirectorState(db, conversationId);
    expect(resumed).toEqual({ state: 'INTAKE', data: { intakeRound: 2 } });
    const told = describeDirectorStateForContext(getConversationById(db, conversationId)!);
    expect(told).toContain('INTAKE');
    expect(told).toContain('intakeRound');
    // And it carries on from there, not from IDLE.
    transitionDirectorState(db, activityLog, conversationId, 'DRAFTING_BRIEF', {
      trigger: 'enough_understood',
    });
    expect(getDirectorState(db, conversationId).state).toBe('DRAFTING_BRIEF');
  });
});
