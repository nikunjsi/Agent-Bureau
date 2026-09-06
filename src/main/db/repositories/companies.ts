import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  CompanySchema,
  NewCompanyInputSchema,
  emptyFloorLayout,
  type Company,
  type NewCompanyInput,
} from '../../../shared/models/company';
import type { FloorLayout } from '../../../shared/floor/layout';
import { FloorLayoutSchema } from '../../../shared/floor/layout';

export function insertCompany(db: Database.Database, input: NewCompanyInput): Company {
  const parsed = NewCompanyInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO companies (id, name, home_path, director_employee_id, floor_layout, settings, created_at, updated_at)
     VALUES (@id, @name, @home_path, NULL, @floor_layout, @settings, @created_at, @updated_at)`,
  ).run({
    id,
    name: parsed.name,
    home_path: parsed.home_path,
    // The empty layout has to know its own company id, which only exists
    // here — see NewCompanyInputSchema for why this is not a schema default.
    floor_layout: toJsonColumn(parsed.floor_layout ?? emptyFloorLayout(id)),
    settings: toJsonColumn(parsed.settings),
    created_at: now,
    updated_at: now,
  });
  return getCompanyById(db, id) as Company;
}

/**
 * §13.3 step 8: "Persist the result in companies.floor_layout so it never
 * changes unexpectedly." Validated on the way in rather than trusted —
 * this column is what M12 renders from, and a malformed layout reaching
 * the renderer would surface as a drawing bug rather than a data one.
 */
export function setCompanyFloorLayout(db: Database.Database, companyId: string, layout: FloorLayout): void {
  const validated = FloorLayoutSchema.parse(layout);
  db.prepare('UPDATE companies SET floor_layout = ? WHERE id = ?').run(toJsonColumn(validated), companyId);
}

/** The single company row, if one exists. Nothing CREATES a company yet —
 * that is M13's setup wizard (§14.1) — so this returns null on a fresh
 * install, and every caller has to mean something sensible by that. */
export function getSoleCompany(db: Database.Database): Company | null {
  const row = db.prepare('SELECT * FROM companies ORDER BY created_at LIMIT 1').get();
  return row ? CompanySchema.parse(row) : null;
}

export function setCompanyDirector(db: Database.Database, companyId: string, directorEmployeeId: string): void {
  db.prepare('UPDATE companies SET director_employee_id = ? WHERE id = ?').run(directorEmployeeId, companyId);
}

export function getCompanyById(db: Database.Database, id: string): Company | null {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  return row ? CompanySchema.parse(row) : null;
}
