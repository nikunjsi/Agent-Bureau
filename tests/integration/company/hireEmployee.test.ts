import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getMemoryDir } from '../../../src/main/db/paths';
import { hireEmployee, renameEmployee, RoleNotAvailableError } from '../../../src/main/company/hireEmployee';
import { FirstNameTakenError, NamePoolExhaustedError, firstNameOf } from '../../../src/main/company/allocateName';
import { readFloorLayout } from '../../../src/main/company/persistFloorLayout';
import { listEmployees, getEmployeeById, insertEmployee } from '../../../src/main/db/repositories/employees';
import { setPackEnabled, recordPackValidation } from '../../../src/main/db/repositories/packs';
import { EMPLOYEE_NAME_POOL } from '../../../src/shared/company/nameList';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §6.8 hiring, driven through the real `hireEmployee` against the real
 * shipped packs and a real migrated database. Nothing here re-implements
 * the operation it verifies.
 */
describe('§6.8 hiring', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-hire-'));
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

  function hire(roleKey = 'engineering:developer', extra: Record<string, unknown> = {}) {
    return hireEmployee({ db, activityLog, companyId, baseDir, roleKey, ...extra });
  }

  it('instantiates a role as a named employee with a desk', () => {
    const { employee, desk } = hire();

    expect(employee.role_key).toBe('engineering:developer');
    expect(EMPLOYEE_NAME_POOL).toContain(employee.name);
    expect(employee.sprite_variant).toMatch(/^dev_\d$/);
    // The desk is real: it exists in the persisted layout and belongs to
    // this employee, not just a pair of numbers on the row.
    const layout = readFloorLayout(db, companyId);
    const seat = layout.rooms
      .flatMap((r) => r.desks)
      .find((d) => d.x === desk.x && d.y === desk.y);
    expect(seat?.employeeId).toBe(employee.id);
  });

  it('creates the employee’s own memory file (§12.1/§12.2)', () => {
    const { employee } = hire();
    const notes = path.join(getMemoryDir(baseDir), 'employee', employee.id, 'notes.md');
    expect(existsSync(notes)).toBe(true);
    expect(readFileSync(notes, 'utf8')).toContain(employee.name);
    // Indexed too — memory that is not searchable is not memory.
    const row = db.prepare('SELECT scope_ref FROM memory WHERE path = ?').get(`employee/${employee.id}/notes.md`);
    expect(row).toEqual({ scope_ref: employee.id });
  });

  it('emits exactly one activity event for a hire', () => {
    hire();
    const rows = db.prepare("SELECT type FROM events WHERE type LIKE 'company.%'").all() as { type: string }[];
    // The pack install emits its own; the hire adds exactly one more.
    expect(rows.filter((r) => r.type === 'company.employee_hired')).toHaveLength(1);
    // A hire re-packs the floor, but that is not a second user-visible
    // action — no `floor_rearranged` alongside it.
    expect(rows.filter((r) => r.type === 'company.floor_rearranged')).toHaveLength(0);
  });

  it('records NO model at hire — resolution belongs to the spawn (migration 0008)', () => {
    // This asserted the opposite until 2026-09-07. Hiring used to resolve
    // a concrete id into `employees.model`, and `Supervisor.assign()`
    // re-resolved from the role and ignored it — the M7→M4 boundary
    // check's finding. `employees.model` is a RECORD of what launched
    // now, so before any spawn it is correctly null.
    const { employee } = hire();
    expect(employee.model).toBeNull();
    expect(employee.model_tier_override).toBeNull(); // no override asked for
  });

  it('honours a hire-time tier override by storing the TIER, without touching the role', () => {
    // The parking-lot decision (2026-09-02): the Director may judge that
    // THIS work needs a different tier than the role's author chose.
    //
    // Stored as a tier, not a resolved id: an id pinned here would stop
    // tracking the role, stop tracking `settings.engines.modelTiers`, and
    // be meaningless if the employee's engine changed. See migration 0008.
    const fast = hire('engineering:developer', { modelTier: 'fast' }).employee;
    const capable = hire('engineering:architect', { modelTier: 'capable' }).employee;
    expect(fast.model_tier_override).toBe('fast');
    expect(capable.model_tier_override).toBe('capable');
    // And the role itself is unchanged — the override is per-employee.
    const role = db.prepare('SELECT model_preference FROM roles WHERE full_key = ?').get('engineering:developer');
    expect(role).toEqual({ model_preference: JSON.stringify(['balanced', 'capable']) });
    // That the tier actually reaches the launch is proven on the real
    // hire→spawn path in tests/contract/m7ToM4Boundary.test.ts — asserting
    // it here would only re-check the column this test just wrote.
  });

  it('seats several employees at distinct desks', () => {
    const a = hire().employee;
    const b = hire().employee;
    const c = hire('engineering:tester').employee;
    const desks = [a, b, c].map((e) => `${e.desk_x},${e.desk_y}`);
    expect(new Set(desks).size).toBe(3);
  });

  it('gives every employee a different first name (§6.8)', () => {
    const names = [hire().employee, hire().employee, hire().employee].map((e) => firstNameOf(e.name));
    expect(new Set(names).size).toBe(3);
  });

  // --- the rule employees.name UNIQUE does NOT enforce -------------------

  it('refuses a supplied name whose FIRST name is taken, which the DB constraint would allow', () => {
    hire('engineering:developer', { name: 'Ravi Kumar' });

    // Proof the DB alone would not have caught it: the two full names are
    // distinct, so UNIQUE(name) is satisfied.
    expect('Ravi Kumar').not.toBe('Ravi Sharma');
    expect(() => hire('engineering:tester', { name: 'Ravi Sharma' })).toThrow(FirstNameTakenError);
  });

  it('applies the rule case-insensitively', () => {
    hire('engineering:developer', { name: 'Ravi' });
    expect(() => hire('engineering:tester', { name: 'ravi patel' })).toThrow(FirstNameTakenError);
  });

  it('counts ARCHIVED employees — a fired Ravi still holds the name', async () => {
    const { employee } = hire('engineering:developer', { name: 'Ravi' });
    const { fireEmployee } = await import('../../../src/main/company/fireEmployee');
    await fireEmployee({ db, activityLog, companyId, employeeId: employee.id });

    // Deliberate: it keeps a rehire unambiguous, and stops a second Ravi
    // appearing while the first could still come back.
    expect(() => hire('engineering:tester', { name: 'Ravi Sharma' })).toThrow(FirstNameTakenError);
  });

  it('refuses to hire when the pool is exhausted rather than inventing "Ravi 2"', () => {
    // Take every name in the pool. Through the real repository, not raw
    // SQL — a hand-written INSERT here would be a fixture standing in for
    // the write path, and would drift from it silently.
    for (const name of EMPLOYEE_NAME_POOL) {
      insertEmployee(db, {
        name,
        role_key: 'engineering:developer',
        desk_x: 0,
        desk_y: 0,
        sprite_variant: 'dev_0',
        engine: 'claude-code',
        autonomy: 'guided',
      });
    }
    expect(() => hire()).toThrow(NamePoolExhaustedError);
    // And the escape hatch the error names actually works.
    expect(() => hire('engineering:developer', { name: 'Bartholomew' })).not.toThrow();
  });

  // --- availability ------------------------------------------------------

  it('refuses a role whose pack the user switched off', () => {
    setPackEnabled(db, 'engineering', false);
    expect(() => hire()).toThrow(RoleNotAvailableError);
  });

  it('refuses a role whose pack failed validation', () => {
    // §6.7's "disabled with a readable error" has to reach hiring, or the
    // roles of a broken pack keep working while the Packs screen says
    // otherwise.
    recordPackValidation(db, 'engineering', 'failed', 'roles/developer.yaml: prompt file is missing');
    expect(() => hire()).toThrow(/not available/);
  });

  it('refuses a role that does not exist', () => {
    expect(() => hire('engineering:nobody')).toThrow(RoleNotAvailableError);
  });
});

describe('§6.8 renaming', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-rename-'));
    baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    companyId = seedCompany(db, path.join(tmpDir, 'home')).id;
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renames anyone, and emits an event for it', () => {
    const { employee } = hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'engineering:developer' });
    const renamed = renameEmployee({ db, activityLog, employeeId: employee.id, name: 'Morgan' });

    expect(renamed.name).toBe('Morgan');
    const rows = db.prepare("SELECT type FROM events WHERE type = 'company.employee_renamed'").all();
    expect(rows).toHaveLength(1);
  });

  it('enforces the first-name rule — the place it actually bites', () => {
    const a = hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'engineering:developer', name: 'Ravi' });
    const b = hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'engineering:tester', name: 'Mei' });
    expect(() => renameEmployee({ db, activityLog, employeeId: b.employee.id, name: 'Ravi Sharma' })).toThrow(
      FirstNameTakenError,
    );
    expect(getEmployeeById(db, a.employee.id)!.name).toBe('Ravi');
  });

  it('lets someone be renamed to a variation of their OWN name', () => {
    const { employee } = hireEmployee({
      db, activityLog, companyId, baseDir, roleKey: 'engineering:developer', name: 'Ravi',
    });
    expect(() => renameEmployee({ db, activityLog, employeeId: employee.id, name: 'Ravi Kumar' })).not.toThrow();
    expect(listEmployees(db)).toHaveLength(1);
  });
});
