import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { moveEmployeeToDesk, NotADeskError } from '../../../src/main/company/moveEmployeeToDesk';
import { readFloorLayout } from '../../../src/main/company/persistFloorLayout';
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import type { FloorLayout } from '../../../src/shared/floor/layout';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §13.3: "The user can drag employees between desks; the layout persists."
 *
 * The drag UI is M12. This is the persistence half, and it is what makes
 * the generator take the previous layout as an input — without a pin, the
 * next hire's re-pack would silently undo every manual placement.
 */
describe('§13.3 manual desk placement', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-desk-'));
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
    return hireEmployee({ db, activityLog, companyId, baseDir, roleKey }).employee;
  }

  function freeDeskIn(layout: FloorLayout, departmentKey: string) {
    return layout.rooms
      .find((r) => r.departmentKey === departmentKey)!
      .desks.find((d) => d.employeeId === null)!;
  }

  it('moves an employee to a free desk and pins it', () => {
    const employee = hire();
    const target = freeDeskIn(readFloorLayout(db, companyId), 'engineering');

    moveEmployeeToDesk({
      db,
      activityLog,
      companyId,
      employeeId: employee.id,
      x: target.x,
      y: target.y,
    });

    const after = getEmployeeById(db, employee.id)!;
    expect({ x: after.desk_x, y: after.desk_y }).toEqual({ x: target.x, y: target.y });
    const desk = readFloorLayout(db, companyId)
      .rooms.flatMap((r) => r.desks)
      .find((d) => d.employeeId === employee.id)!;
    expect(desk.pinned).toBe(true);
  });

  it('the placement SURVIVES a later hire — the whole point', () => {
    const employee = hire();
    const target = freeDeskIn(readFloorLayout(db, companyId), 'engineering');
    moveEmployeeToDesk({
      db,
      activityLog,
      companyId,
      employeeId: employee.id,
      x: target.x,
      y: target.y,
    });

    // A hire re-packs the floor. Without the pin, this is where the
    // manual placement would silently vanish.
    hire('engineering:tester');

    const after = getEmployeeById(db, employee.id)!;
    expect({ x: after.desk_x, y: after.desk_y }).toEqual({ x: target.x, y: target.y });
  });

  it('swaps when the target desk is occupied, and pins both', () => {
    const a = hire();
    const b = hire('engineering:tester');
    const before = { a: getEmployeeById(db, a.id)!, b: getEmployeeById(db, b.id)! };

    moveEmployeeToDesk({
      db,
      activityLog,
      companyId,
      employeeId: a.id,
      x: before.b.desk_x,
      y: before.b.desk_y,
    });

    const after = { a: getEmployeeById(db, a.id)!, b: getEmployeeById(db, b.id)! };
    expect({ x: after.a.desk_x, y: after.a.desk_y }).toEqual({
      x: before.b.desk_x,
      y: before.b.desk_y,
    });
    expect({ x: after.b.desk_x, y: after.b.desk_y }).toEqual({
      x: before.a.desk_x,
      y: before.a.desk_y,
    });

    // Both pinned: the displaced employee did not choose to move, so
    // leaving them unpinned would let the next re-pack move them again.
    const desks = readFloorLayout(db, companyId).rooms.flatMap((r) => r.desks);
    expect(desks.find((d) => d.employeeId === a.id)!.pinned).toBe(true);
    expect(desks.find((d) => d.employeeId === b.id)!.pinned).toBe(true);
  });

  it('refuses a target that is not a desk', () => {
    const employee = hire();
    expect(() =>
      moveEmployeeToDesk({ db, activityLog, companyId, employeeId: employee.id, x: 0, y: 23 }),
    ).toThrow(NotADeskError);
  });

  it('emits company.floor_rearranged — the event that belongs to a manual change', () => {
    const employee = hire();
    const target = freeDeskIn(readFloorLayout(db, companyId), 'engineering');
    moveEmployeeToDesk({
      db,
      activityLog,
      companyId,
      employeeId: employee.id,
      x: target.x,
      y: target.y,
    });

    const rows = db
      .prepare("SELECT payload FROM events WHERE type = 'company.floor_rearranged'")
      .all() as { payload: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ reason: 'desk_moved' });
  });
});
