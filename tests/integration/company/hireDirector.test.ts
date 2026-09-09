import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import {
  hireEmployee,
  CannotHireSecondDirectorError,
} from '../../../src/main/company/hireEmployee';
import { fireEmployee, CannotFireDirectorError } from '../../../src/main/company/fireEmployee';
import { DIRECTOR_ROLE_FULL_KEY } from '../../../src/main/company/directorRole';
import { getCompanyById } from '../../../src/main/db/repositories/companies';
import { getDirectorEmployee } from '../../../src/main/db/repositories/employees';
import { deliverabilityOf } from '../../../src/main/messages/deliverability';
import { parseMessageAddress } from '../../../src/main/messages/addressing';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';
import type { Company } from '../../../src/shared/models/company';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * **Condition (a) on M9's close**, recorded in PROJECT-CHECKLIST §2 by
 * session 1 and settled here.
 *
 * `hireEmployee.ts` hardcoded `is_director: false` for six milestones, so
 * **no Director employee could exist**. Three mechanisms written for one
 * were therefore unreachable in production — `budgetEnforcement`'s reserve
 * carve-out, §11.5's breaker exemption, and `deliverability.ts`'s
 * `WHERE is_director = 1` — and `generateFloorLayout:330` looked for a
 * director it had never once found.
 *
 * **Nothing here is seeded.** Three integration tests in this repo already
 * write `is_director: true` straight through `insertEmployee`, so seeding
 * one was a single line away, and that is exactly what session 1's
 * condition forbids: `hireEmployee` is production infrastructure that
 * *should* be able to produce this row, so a seeded one would prove a row
 * no user can produce. Every Director below comes out of the real hire
 * path, from the real shipped `operations` pack, installed by the real
 * installer.
 */
describe('hiring the Director, through the production path (§8.0, §6.8)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let company: Company;

  function hire(roleKey: string, name?: string) {
    return hireEmployee({
      db,
      activityLog,
      companyId: company.id,
      baseDir: tmpDir,
      roleKey,
      ...(name === undefined ? {} : { name }),
    });
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-hire-director-'));
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
    company = seedCompany(db, tmpDir);
    // The real shipped packs, through the real installer — `director.yaml`
    // as authored, not a fixture role that happens to be called director.
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'operations' });
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'engineering' });
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets is_director from the ROLE, not from a caller-supplied flag', () => {
    const { employee } = hire(DIRECTOR_ROLE_FULL_KEY);
    expect(employee.is_director).toBe(true);
    expect(employee.role_key).toBe(DIRECTOR_ROLE_FULL_KEY);
    // §8.0: "Fixed at guided." The role's own default, carried through.
    expect(employee.autonomy).toBe('guided');
    // The parallel proof: hiring anyone else through the identical call
    // does NOT produce a Director, so the flag tracks the role rather than
    // the code path.
    expect(hire('engineering:developer').employee.is_director).toBe(false);
  });

  it('points companies.director_employee_id at the same row, in the same hire', () => {
    // §5.1.1 describes this bootstrap and nothing had ever written the
    // column outside `deferredForeignKeys.test.ts`. `is_director` stays
    // the single reader; this asserts the pointer cannot drift from it.
    expect(getCompanyById(db, company.id)?.director_employee_id).toBeNull();
    const { employee } = hire(DIRECTOR_ROLE_FULL_KEY);
    expect(getCompanyById(db, company.id)?.director_employee_id).toBe(employee.id);
    expect(getDirectorEmployee(db)?.id).toBe(employee.id);
  });

  it('gives the Director §13.5’s corner office, not a department desk', () => {
    // `generateFloorLayout:330` has looked for a director since M7 and has
    // never found one. Checked rather than assumed.
    const { employee } = hire(DIRECTOR_ROLE_FULL_KEY);
    const layout = getCompanyById(db, company.id)!.floor_layout;
    const office = layout.rooms.find((room) => room.kind === 'director');
    expect(office, 'the generator must emit a director office').toBeDefined();
    expect(office!.desks.map((desk) => desk.employeeId)).toEqual([employee.id]);
    expect({ x: employee.desk_x, y: employee.desk_y }).toEqual({
      x: office!.desks[0]!.x,
      y: office!.desks[0]!.y,
    });

    // And nobody else is put in it: a developer hired afterwards lands in
    // their department's room, and the Director stays where they are.
    const developer = hire('engineering:developer');
    const after = getCompanyById(db, company.id)!.floor_layout;
    const officeAfter = after.rooms.find((room) => room.kind === 'director')!;
    expect(officeAfter.desks.map((desk) => desk.employeeId)).toEqual([employee.id]);
    expect(
      after.rooms
        .filter((room) => room.kind !== 'director')
        .flatMap((room) => room.desks)
        .map((desk) => desk.employeeId),
    ).toContain(developer.employee.id);
  });

  it('refuses a second Director, the way fireEmployee refuses to fire the first', () => {
    const first = hire(DIRECTOR_ROLE_FULL_KEY);
    expect(() => hire(DIRECTOR_ROLE_FULL_KEY, 'Someone')).toThrow(CannotHireSecondDirectorError);
    // Refused means refused: no row, no desk, and the first Director is
    // untouched.
    expect((db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }).n).toBe(1);
    expect(getDirectorEmployee(db)?.id).toBe(first.employee.id);
    expect(getCompanyById(db, company.id)?.director_employee_id).toBe(first.employee.id);
  });

  it('still cannot be fired — the two rules are one rule read from both ends', async () => {
    const { employee } = hire(DIRECTOR_ROLE_FULL_KEY);
    await expect(
      fireEmployee({ db, activityLog, companyId: company.id, employeeId: employee.id }),
    ).rejects.toThrow(CannotFireDirectorError);
    // Until now this refusal has been unreachable: no row could carry the
    // flag it reads. This is the first time it has ever been exercised
    // against one.
    expect(getDirectorEmployee(db)?.id).toBe(employee.id);
  });

  it('brings deliverability.ts’s dead director query to life', () => {
    const registry = new SupervisorRegistry();
    const deps = { db, supervisorRegistry: registry };

    // Before the hire: held, because there is no Director — the state M8
    // shipped and could not get out of.
    expect(deliverabilityOf(deps, parseMessageAddress('director'))).toEqual({
      kind: 'hold',
      reason: 'no_director_yet',
    });

    hire(DIRECTOR_ROLE_FULL_KEY);

    // After: the query RESOLVES. It still holds, but for an entirely
    // different and correct reason — §9.7's "target is off: held, not
    // auto-started. Bureau never spends money to deliver a message."
    // Confirming the reason changed is the point; a bare "still held"
    // would look identical to the bug.
    expect(deliverabilityOf(deps, parseMessageAddress('director'))).toEqual({
      kind: 'hold',
      reason: 'target_not_running',
    });
  });

  it('emits exactly one hire event, and says which kind of hire it was', () => {
    const before = (
      db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'company.employee_hired'")
        .get() as {
        n: number;
      }
    ).n;
    const { employee } = hire(DIRECTOR_ROLE_FULL_KEY);
    const rows = db
      .prepare("SELECT payload FROM events WHERE type = 'company.employee_hired'")
      .all() as { payload: string }[];
    expect(rows.length).toBe(before + 1);
    const payload = JSON.parse(rows.at(-1)!.payload) as Record<string, unknown>;
    expect(payload['isDirector']).toBe(true);
    expect(payload['name']).toBe(employee.name);
  });
});
