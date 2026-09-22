import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getMemoryDir } from '../../../src/main/db/paths';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertTask } from '../../../src/main/db/repositories/tasks';
import { getRoleByFullKey } from '../../../src/main/db/repositories/roles';
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { answerCheckpoint } from '../../../src/main/checkpoints/answerCheckpoint';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';
import type { Employee } from '../../../src/shared/models/employee';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * # M10's gate
 *
 * §28: *"a decision recorded in one session is present in the next
 * session's context, verified by inspecting the `memory.injected` event."*
 *
 * **This gate passes in full, and no part of it is deferred.** That is
 * worth saying plainly because M9's could not, and its record (NEXT-VERSION
 * §L.1) is the precedent for how a session says so honestly. The difference
 * is that every producer this gate needs already exists: `answerCheckpoint`
 * writes the decision, `writeMemory` puts it in layer 1, `composeMemoryPack`
 * reads it back and `Supervisor.assign()` injects it. Nothing is seeded and
 * nothing is stood in for except the engine process itself.
 *
 * ## What "one session" and "the next session" mean here
 *
 * A *session* is an employee run. Session one is the decision being
 * answered — a real `decision` checkpoint, answered through the real
 * `answerCheckpoint`, which appends `project/decisions.md` through §12.5's
 * real decision log. Session two is a **different employee** starting a
 * **different task**, days later as far as the code is concerned, whose
 * `assign()` composes a memory pack.
 *
 * ## Two assertions, deliberately, because one of them proves nothing alone
 *
 * §28 says to verify by inspecting `memory.injected`, and that is asserted.
 * But an event is a *claim about* an injection: a Core that logged the
 * event and sent nothing would pass a test that only read events, and the
 * event's own name would be the lie. So the adapter's received text is
 * asserted too. The event says what was included; the send proves it
 * arrived.
 */
describe('M10 gate: a decision recorded in one session is in the next session’s context', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let registry: SupervisorRegistry;
  let live: Supervisor[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-m10-gate-'));
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
    registry = new SupervisorRegistry();
    live = [];

    seedCompany(db, tmpDir);
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'engineering' });
  });

  afterEach(async () => {
    await Promise.all(live.map((supervisor) => supervisor.stop(0)));
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function companyId(): string {
    return (db.prepare('SELECT id FROM companies LIMIT 1').get() as { id: string }).id;
  }

  function hire(): Employee {
    return hireEmployee({
      db,
      activityLog,
      companyId: companyId(),
      baseDir: tmpDir,
      roleKey: 'engineering:developer',
    }).employee;
  }

  it('the decision is written, injected, and both the event and the adapter agree', async () => {
    const project = insertProject(db, { name: 'Ledger', path: tmpDir, kind: 'software' });

    // ---- session one: somebody decides something --------------------
    //
    // A real `decision` checkpoint through the real repository, answered
    // through the real `answerCheckpoint`. §12.5's decision log is a
    // *consequence* of answering; nothing here writes a memory note
    // directly, which is the point — the gate is about a decision made in
    // the ordinary way ending up as knowledge.
    const checkpoint = insertCheckpoint(db, activityLog, {
      project_id: project.id,
      type: 'decision',
      urgency: 'soon',
      title: 'Database: SQLite or Postgres?',
      context: 'The API needs persistence and the choice affects deployment.',
      options: [
        {
          id: 'sqlite',
          reversible: true,
          label: 'SQLite',
          consequence: 'Single file, no server; no concurrent writers.',
          recommended: true,
        },
        {
          id: 'postgres',
          label: 'Postgres',
          consequence: 'Concurrent writers; needs a server to run and to pay for.',
        },
      ],
      default_action: 'sqlite',
    });

    const answered = answerCheckpoint(
      { db, activityLog, baseDir: tmpDir },
      {
        checkpointId: checkpoint.id,
        optionId: 'sqlite',
        freeText: 'This runs on one machine for one user.',
        source: 'user',
      },
    );
    expect(answered.ok).toBe(true);

    // Layer 1 has it — a real markdown file, readable without Bureau.
    const decisionsPath = path.join(getMemoryDir(tmpDir), 'project', project.id, 'decisions.md');
    expect(readFileSync(decisionsPath, 'utf8')).toContain('one machine for one user');

    // ---- session two: a different employee, a different task ---------
    const employee = hire();
    const role = getRoleByFullKey(db, employee.role_key);
    const task = insertTask(db, {
      project_id: project.id,
      title: 'Add the persistence layer',
      body: 'Wire up storage for the API.',
      acceptance_criteria: ['data survives a restart'],
      status: 'assigned',
    });

    const adapter = new FakeAdapter({
      events: [{ t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' }],
    });
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter,
      supervisorRegistry: registry,
      heartbeatCheckIntervalMs: 999_999_999,
    });
    live.push(supervisor);

    await supervisor.assign({
      employee,
      role: role!,
      task,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });

    // ---- the gate, both halves --------------------------------------

    // 1. §28's own instrument: the `memory.injected` event, and what it
    //    says was included. §12.3's stated purpose for this event is that
    //    "what did the agent know?" is always answerable — so the payload
    //    has to name the note, not merely count it.
    const injected = db
      .prepare("SELECT payload FROM events WHERE type = 'memory.injected' ORDER BY seq")
      .all() as { payload: string }[];
    expect(injected).toHaveLength(1);

    const payload = JSON.parse(injected[0]!.payload) as {
      items: { kind: string; path: string }[];
      estimatedTokens: number;
      budgetTokens: number;
      semantic: string;
    };
    const decisionItem = payload.items.find(
      (item) => item.path === `project/${project.id}/decisions.md`,
    );
    expect(decisionItem, 'the decision log must be named in the event').toBeDefined();
    expect(decisionItem?.kind).toBe('project_decision');
    expect(payload.estimatedTokens).toBeLessThanOrEqual(payload.budgetTokens);
    // Layer 3 is off by default and says so rather than staying silent.
    expect(payload.semantic).toBe('off');

    // 2. The delivery the event is a claim about. Without this, a Core that
    //    logged the event and sent nothing would pass.
    const sent = adapter.sentMessages.map((entry) => entry.text).join('\n');
    expect(sent).toContain('one machine for one user');
    expect(sent).toContain('SQLite');
    // And the task itself is still there — the pack is added to the task,
    // not substituted for it.
    expect(sent).toContain('Wire up storage for the API.');
  });

  it('a role that reads no memory scopes gets nothing, and no event is emitted', async () => {
    // The control, and it is a real configuration rather than a contrived
    // one: §6.5 lets a role declare its own `memory_scopes`, and an empty
    // list means "reads no memory". `allowedScopes` treats that as the
    // literal answer rather than as "everything", which is the fail-closed
    // reading and the one that cannot leak a company standard into a role
    // never meant to see it.
    //
    // It is also the control for the event: a `memory.injected` emitted on
    // every assignment regardless of content would make the event useless
    // for §12.3's stated purpose and would break "one event per state
    // change" — nothing was injected, so nothing happened to record.
    const project = insertProject(db, { name: 'Empty', path: tmpDir, kind: 'software' });
    const employee = hire();
    const task = insertTask(db, {
      project_id: project.id,
      title: 'Do a thing',
      body: 'A task with no relevant memory.',
      acceptance_criteria: ['done'],
      status: 'assigned',
    });

    // The memory tree is NOT empty here: the shipped engineering pack seeds
    // a company note and hiring writes the employee's own notes file. So
    // this proves the scope filter, not an absence of data — an empty
    // directory would have proved neither.
    db.prepare("UPDATE roles SET memory_scopes = '[]' WHERE full_key = ?").run(employee.role_key);
    const scopedRole = getRoleByFullKey(db, employee.role_key);

    const adapter = new FakeAdapter({
      events: [{ t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' }],
    });
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter,
      supervisorRegistry: registry,
      heartbeatCheckIntervalMs: 999_999_999,
    });
    live.push(supervisor);

    await supervisor.assign({
      employee,
      role: scopedRole!,
      task,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });

    const injected = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'memory.injected'")
      .get() as { n: number };
    expect(injected.n).toBe(0);
    expect(adapter.sentMessages.map((entry) => entry.text).join('\n')).toBe(
      'A task with no relevant memory.',
    );
  });
});
