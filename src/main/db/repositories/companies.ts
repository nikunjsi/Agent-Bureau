import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { CompanySchema, type Company, type NewCompanyInput } from '../../../shared/models/company';

export function insertCompany(db: Database.Database, input: NewCompanyInput): Company {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO companies (id, name, home_path, director_employee_id, floor_layout, settings, created_at, updated_at)
     VALUES (@id, @name, @home_path, NULL, @floor_layout, @settings, @created_at, @updated_at)`,
  ).run({
    id,
    name: input.name,
    home_path: input.home_path,
    floor_layout: toJsonColumn(input.floor_layout),
    settings: toJsonColumn(input.settings),
    created_at: now,
    updated_at: now,
  });
  return getCompanyById(db, id) as Company;
}

export function setCompanyDirector(db: Database.Database, companyId: string, directorEmployeeId: string): void {
  db.prepare('UPDATE companies SET director_employee_id = ? WHERE id = ?').run(directorEmployeeId, companyId);
}

export function getCompanyById(db: Database.Database, id: string): Company | null {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  return row ? CompanySchema.parse(row) : null;
}
