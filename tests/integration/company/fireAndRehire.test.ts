import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getMemoryDir } from '../../../src/main/db/paths';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import {
  fireEmployee,
  rehireEmployee,
  CannotFireDirectorError,
} from '../../../src/main/company/fireEmployee';
import { writeMemory } from '../../../src/main/memory/memoryStore';
import { searchMemory } from '../../../src/main/memory/searchMemory';
import { rebuildMemoryIndex } from '../../../src/main/memory/rebuildMemoryIndex';
import {
  listEmployees,
  getEmployeeById,
  insertEmployee,
  listArchivedEmployeesForRole,
} from '../../../src/main/db/repositories/employees';
import { readFloorLayout } from '../../../src/main/company/persistFloorLayout';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { getHandler } from '../../../src/main/ipc/handlers';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §6.8: "Firing an employee archives their memory rather than deleting it
 * — if rehired into the same role, they resume with what they learned."
 *
 * The round trip is the test. Asserting "the delete did not happen" would
 * be weaker than what the spec promises, so these drive the real memory
 * search path and prove the knowledge is still reachable.
 */
describe('§6.8 firing archives, and rehiring resumes', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-fire-'));
    baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    companyId = seedCompany(db, path.join(tmpDir, 'home')).id;
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function hire(roleKey = 'engineering:developer') {
    return hireEmployee({ db, activityLog, companyId, baseDir, roleKey });
  }

  it('THE ROUND TRIP: what they learned survives being fired and rehired', async () => {
    const { employee } = hire();

    // Something only this employee knows, written the way they would
    // write it — through the real memory store.
    writeMemory(db, {
      baseDir,
      scope: 'employee',
      scopeRef: employee.id,
      fileName: 'notes.md',
      title: `${employee.name}'s notes`,
      body: '# Notes\n\nThe auth module rejects tokens minted before the clock skew fix.\n',
      source: 'observed',
    });
    expect(searchMemory(db, 'skew', { scopes: ['employee'] })).toHaveLength(1);

    await fireEmployee({ db, activityLog, companyId, employeeId: employee.id });

    // Fired: off the roster, but the file is still on disk and still
    // indexed. "Archives rather than deletes" is a claim about the
    // KNOWLEDGE, so that is what gets asserted.
    expect(listEmployees(db)).toHaveLength(0);
    expect(existsSync(path.join(getMemoryDir(baseDir), 'employee', employee.id, 'notes.md'))).toBe(
      true,
    );

    const rehired = rehireEmployee({ db, activityLog, companyId, employeeId: employee.id });

    expect(rehired.id).toBe(employee.id); // the id is what keeps the memory reachable
    expect(rehired.name).toBe(employee.name);
    expect(rehired.archived_at).toBeNull();

    const hits = searchMemory(db, 'skew', { scopes: ['employee'], scopeRef: rehired.id });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toContain('clock skew fix');
  });

  it('survives an index rebuild too — the files are the truth', () => {
    const { employee } = hire();
    writeMemory(db, {
      baseDir,
      scope: 'employee',
      scopeRef: employee.id,
      fileName: 'notes.md',
      title: 'Notes',
      body: '# Notes\n\nPrefer integration tests for the parser.\n',
      source: 'observed',
    });

    // Destroy layer 2 entirely and re-derive it from layer 1.
    db.prepare('DELETE FROM memory').run();
    rebuildMemoryIndex(db, baseDir);

    expect(searchMemory(db, 'parser', { scopes: ['employee'] })).toHaveLength(1);
  });

  it('archives rather than deletes the row — the id must not dangle', async () => {
    const { employee } = hire();
    await fireEmployee({ db, activityLog, companyId, employeeId: employee.id });

    const row = getEmployeeById(db, employee.id);
    expect(row).not.toBeNull();
    expect(row!.archived_at).not.toBeNull();
    expect(row!.status).toBe('off');
  });

  it('finds an archived employee by the role they held', async () => {
    const { employee } = hire();
    await fireEmployee({ db, activityLog, companyId, employeeId: employee.id });

    const archived = listArchivedEmployeesForRole(db, 'engineering:developer');
    expect(archived.map((e) => e.id)).toEqual([employee.id]);
  });

  it('frees the desk, and the next hire can take it', async () => {
    const first = hire().employee;
    await fireEmployee({ db, activityLog, companyId, employeeId: first.id });

    const layout = readFloorLayout(db, companyId);
    expect(layout.rooms.flatMap((r) => r.desks).some((d) => d.employeeId === first.id)).toBe(false);

    const second = hire().employee;
    expect(second.id).not.toBe(first.id);
    expect(
      readFloorLayout(db, companyId)
        .rooms.flatMap((r) => r.desks)
        .some((d) => d.employeeId === second.id),
    ).toBe(true);
  });

  it('emits exactly one event for a fire, and one for a rehire', async () => {
    const { employee } = hire();
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'company.%'")
      .get() as { n: number };

    await fireEmployee({ db, activityLog, companyId, employeeId: employee.id });
    const afterFire = db.prepare("SELECT type FROM events WHERE type LIKE 'company.%'").all() as {
      type: string;
    }[];
    expect(afterFire.length).toBe(before.n + 1);
    expect(afterFire[afterFire.length - 1]!.type).toBe('company.employee_fired');

    rehireEmployee({ db, activityLog, companyId, employeeId: employee.id });
    const afterRehire = db.prepare("SELECT type FROM events WHERE type LIKE 'company.%'").all() as {
      type: string;
    }[];
    expect(afterRehire.length).toBe(before.n + 2);
    // A rehire reuses `employee_hired` with `rehired: true` rather than
    // adding a type — same action, different provenance.
    expect(afterRehire[afterRehire.length - 1]!.type).toBe('company.employee_hired');
  });

  it('is idempotent in both directions', async () => {
    const { employee } = hire();
    await fireEmployee({ db, activityLog, companyId, employeeId: employee.id });
    await expect(
      fireEmployee({ db, activityLog, companyId, employeeId: employee.id }),
    ).resolves.toBeDefined();

    rehireEmployee({ db, activityLog, companyId, employeeId: employee.id });
    expect(() =>
      rehireEmployee({ db, activityLog, companyId, employeeId: employee.id }),
    ).not.toThrow();
  });
  describe('company.hire rehires rather than replacing (X-6)', () => {
    async function hireThroughIpc(roleKey: string, name?: string) {
      const result = await dispatchIpcCall(
        'company:hire',
        getMethodSchema('company', 'hire'),
        getHandler('company', 'hire'),
        { db, activityLog, baseDir } as unknown as HandlerContext,
        true,
        { roleKey, ...(name === undefined ? {} : { name }) },
      );
      expect(result.ok, JSON.stringify(result).slice(0, 200)).toBe(true);
      return (result as { ok: true; data: { item: { id: string; name: string } } }).data.item;
    }

    it('brings back the same person, with their id and notes, and emits the rehire event', async () => {
      const first = hire('engineering:developer').employee;
      writeMemory(db, {
        baseDir,
        scope: 'employee',
        scopeRef: first.id,
        fileName: 'notes.md',
        title: 'What I learned',
        body: '# Notes\n\nThe build script needs node 22.\n',
        source: 'observed',
      });
      await fireEmployee({ db, activityLog, companyId, employeeId: first.id });

      const rehired = await hireThroughIpc('engineering:developer');
      expect(rehired.id, 'a new person was hired instead of the archived one').toBe(first.id);
      expect(rehired.name).toBe(first.name);
      expect(getEmployeeById(db, first.id)?.archived_at).toBeNull();
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM memory WHERE scope = 'employee' AND scope_ref = ?")
          .get(first.id),
      ).toEqual({ n: 1 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'company.employee_hired'").get(),
      ).toEqual({ n: 2 });
    });

    it('a caller who names someone new gets a new person, and the archived one stays archived', async () => {
      const first = hire('engineering:developer').employee;
      await fireEmployee({ db, activityLog, companyId, employeeId: first.id });

      const fresh = await hireThroughIpc('engineering:developer', 'Nadia');
      expect(fresh.id).not.toBe(first.id);
      expect(fresh.name).toBe('Nadia');
      expect(getEmployeeById(db, first.id)?.archived_at).not.toBeNull();
    });

    it('with nobody archived, it hires a new person as before', async () => {
      const hired = await hireThroughIpc('engineering:developer');
      expect(getEmployeeById(db, hired.id)?.archived_at).toBeNull();
    });
  });
});

describe('the Director cannot be fired', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-fire-director-'));
    baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    companyId = seedCompany(db, path.join(tmpDir, 'home')).id;
    installShippedPack({ db, activityLog, baseDir, packKey: 'operations' });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses explicitly, rather than leaving the user with nobody to talk to', async () => {
    // The third instance of one pattern: §8.0's budget reserve and the
    // circuit breaker's stop step both exempt the Director for the same
    // reason. Firing is the version with no path back at all — there is
    // nobody left to hire a replacement or raise a budget.
    const director = insertEmployee(db, {
      name: 'Director',
      role_key: 'operations:director',
      is_director: true,
      desk_x: 1,
      desk_y: 1,
      sprite_variant: 'director_0',
      engine: 'claude-code',
      autonomy: 'guided',
    });

    await expect(
      fireEmployee({ db, activityLog, companyId, employeeId: director.id }),
    ).rejects.toThrow(CannotFireDirectorError);
    expect(getEmployeeById(db, director.id)!.archived_at).toBeNull();
  });

  // X-6 / §6.8: "if rehired into the same role, they resume with what they
  // learned" only happens if something CHOOSES rehire. `rehireEmployee` had no
  // production caller, so hiring a developer again produced a stranger with an
  // empty notebook. Decided at pre-M11: `company.hire` rehires the most
  // recently archived employee of that role; a caller naming someone new still
  // gets a new person.
});
