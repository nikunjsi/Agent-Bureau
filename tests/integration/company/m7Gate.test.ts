import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { applyFloorLayout, readFloorLayout } from '../../../src/main/company/persistFloorLayout';
import { installPack } from '../../../src/main/packs/installPack';
import { getCompanyById } from '../../../src/main/db/repositories/companies';
import { listEmployees } from '../../../src/main/db/repositories/employees';
import { listDepartments } from '../../../src/main/db/repositories/departments';
import { writePack, validRoleYaml } from '../../helpers/packFixture';
import { seedCompany, installShippedPack, APP_VERSION_FOR_TESTS } from '../../helpers/companyFixture';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §28's M7 gate, all three parts, run here rather than cited from an
 * earlier session:
 *
 *   1. Hire three employees across two departments.
 *   2. The layout is stable across restarts.
 *   3. A deliberately broken pack is rejected with a clear message.
 *
 * Every assertion runs against production code — the real installer, the
 * real hire operation, the real generator, the real database.
 */
describe('M7 milestone gate', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-m7-gate-'));
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
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GATE 1: hires three employees across two departments', () => {
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });
    installShippedPack({ db, activityLog, baseDir, packKey: 'operations' });

    const developer = hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'engineering:developer' });
    const tester = hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'engineering:tester' });
    const director = hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' });

    const roster = listEmployees(db);
    expect(roster).toHaveLength(3);

    // Two departments, genuinely — not three people in one room.
    const departments = new Set(
      [developer, tester, director].map((h) => h.employee.role_key.split(':')[0]),
    );
    expect(departments).toEqual(new Set(['engineering', 'operations']));

    // Every one of them has a real, distinct desk in the persisted layout.
    const layout = readFloorLayout(db, companyId);
    const seated = layout.rooms
      .flatMap((room) => room.desks)
      .filter((desk) => desk.employeeId !== null)
      .map((desk) => desk.employeeId);
    expect(new Set(seated)).toEqual(new Set(roster.map((e) => e.id)));
    expect(new Set(roster.map((e) => `${e.desk_x},${e.desk_y}`)).size).toBe(3);

    // Distinct first names (§6.8).
    expect(new Set(roster.map((e) => e.name.split(' ')[0])).size).toBe(3);
    // No model yet, and that is correct as of migration 0008: hiring
    // records a tier CHOICE and `Supervisor.assign()` is the only place
    // that resolves one, writing `employees.model` as a record of what
    // launched. None of these three has been spawned. That the tier
    // actually reaches a launch is proven on the real hire→spawn path in
    // tests/contract/m7ToM4Boundary.test.ts.
    expect(roster.every((e) => e.model === null)).toBe(true);
    expect(roster.every((e) => e.model_tier_override === null)).toBe(true); // none asked for one

    // Exactly three hire events — one per hire, no duplicates.
    const hired = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'company.employee_hired'")
      .get();
    expect(hired).toEqual({ n: 3 });
  });

  it('GATE 2: the layout is byte-identical across a restart', () => {
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });
    installShippedPack({ db, activityLog, baseDir, packKey: 'operations' });
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'engineering:developer' });
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'engineering:tester' });
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' });

    const persisted = getCompanyById(db, companyId)!.floor_layout;

    // "Across restarts" means: nothing in memory carries over, the layout
    // is re-derived from the database alone, and it comes out the same.
    // Regenerating from stored state is exactly that, minus the process
    // restart a test cannot perform.
    const regenerated = applyFloorLayout({ db, activityLog, companyId, reason: 'gate-restart' }).layout;

    expect(JSON.stringify(regenerated)).toBe(JSON.stringify(persisted));

    // And a third time, to catch a generator that is merely idempotent
    // after one settling pass rather than genuinely deterministic.
    const third = applyFloorLayout({ db, activityLog, companyId, reason: 'gate-restart-2' }).layout;
    expect(JSON.stringify(third)).toBe(JSON.stringify(persisted));

    // The denormalised per-department rects agree with the layout, so a
    // reader of either sees the same floor.
    for (const department of listDepartments(db)) {
      const room = regenerated.rooms.find((r) => r.departmentKey === department.key)!;
      expect(department.room_rect).toEqual(room.rect);
    }
  });

  it('GATE 3: a deliberately broken pack is rejected with a clear message', () => {
    // Re-run here rather than cited from session 1, per §28's own rule
    // that a gate is demonstrated by the session that closes it.
    const source = writePack(path.join(tmpDir, 'broken'), {
      roles: [
        validRoleYaml({ key: 'architect', sprite_key: 'architect' }),
        validRoleYaml({ key: 'developer' }),
        // Aimed at forbidden ground: Bureau is the sole committer (§10.3).
        validRoleYaml({ key: 'devops', sprite_key: 'devops', tools_allow: ['Bash(git push *)'] }),
      ],
    });

    const result = installPack({
      db,
      activityLog,
      baseDir,
      sourceDir: source,
      origin: 'user',
      appVersion: APP_VERSION_FOR_TESTS,
    });

    expect(result.installed).toBe(false);
    const message = result.errors.join('\n');
    // Clear means: which file, which pattern, and which rule it collides
    // with — enough for the pack author to act without guessing.
    expect(message).toContain('roles/devops.yaml');
    expect(message).toContain('git push *');
    expect(message).toContain('deny.git_write');

    // "Never partially loaded": three roles, one broken, ZERO rows.
    expect(db.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM departments').get()).toEqual({ n: 0 });
  });

  it('GATE 3b: and the good pack next to it still installs, so the validator is not just refusing everything', () => {
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 5 });
  });
});
