import type Database from 'better-sqlite3';
import { EMPLOYEE_NAME_POOL } from '../../shared/company/nameList';
import { listEmployees } from '../db/repositories/employees';

/**
 * §6.8's naming rule, which the database cannot enforce on its own.
 *
 * ## The gap this closes
 *
 * `employees.name` is `TEXT NOT NULL UNIQUE` — a constraint on the FULL
 * name. §6.8's rule is on the FIRST name: "chosen so no two employees
 * share a first name." Those are different rules, and the column satisfies
 * neither half of the harder one: "Ravi Kumar" and "Ravi Sharma" are
 * distinct strings, so SQLite accepts both while the spec forbids it.
 *
 * The rule exists because Bureau addresses employees by first name
 * everywhere — the floor, the chat, a report. Two Ravis makes every one of
 * those ambiguous.
 *
 * ## Archived employees still count
 *
 * A fired employee keeps their name (§6.8 archives, it does not delete).
 * That is deliberate: it makes rehiring unambiguous, and it stops a second
 * Ravi appearing while the first is merely archived and could come back.
 */

export class NamePoolExhaustedError extends Error {
  constructor(taken: number, poolSize: number) {
    super(
      `all ${poolSize} names in the bundled list are taken (${taken} employees, including archived ones). ` +
        `Hire with an explicit name to continue.`,
    );
    this.name = 'NamePoolExhaustedError';
  }
}

export class FirstNameTakenError extends Error {
  constructor(firstName: string, heldBy: string) {
    super(
      `"${firstName}" is already this company's first name for "${heldBy}". ` +
        `Bureau addresses employees by first name, so two would be ambiguous (§6.8).`,
    );
    this.name = 'FirstNameTakenError';
  }
}

/** Case-folded, whitespace-split. "Ravi Kumar" and "ravi" collide. */
export function firstNameOf(fullName: string): string {
  return (fullName.trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/** Every first name currently spoken for, archived employees included. */
export function takenFirstNames(db: Database.Database): Map<string, string> {
  const taken = new Map<string, string>();
  for (const employee of listEmployees(db, { includeArchived: true })) {
    taken.set(firstNameOf(employee.name), employee.name);
  }
  return taken;
}

/**
 * Throws if `candidate` would collide. Used by both hiring and renaming —
 * **renaming is where this rule actually bites**, since pool-allocated
 * names cannot collide by construction but a user-chosen one can.
 *
 * `excludeEmployeeId` lets someone be renamed to a variation of their own
 * name ("Ravi" → "Ravi K.") without colliding with themselves.
 */
export function assertFirstNameAvailable(
  db: Database.Database,
  candidate: string,
  excludeEmployeeId?: string,
): void {
  const first = firstNameOf(candidate);
  for (const employee of listEmployees(db, { includeArchived: true })) {
    if (employee.id === excludeEmployeeId) continue;
    if (firstNameOf(employee.name) === first) {
      throw new FirstNameTakenError(first, employee.name);
    }
  }
}

/**
 * Picks the next name.
 *
 * Deterministic given the company id and who is already employed — the
 * offset is derived from the company id so two different companies do not
 * both start at "Adaora", and the scan is in pool order from there so the
 * result is reproducible in tests and stable across restarts.
 *
 * **Exhaustion fails closed and does NOT invent "Ravi 2".** Auto-suffixing
 * is exactly what makes a product feel like a database, and §6.8's whole
 * premise is that these read as colleagues. Refusing clearly, and letting
 * a person supply a name, is the better failure. A larger pool or a
 * surname scheme is a next-version question — see docs/NEXT-VERSION.md.
 */
export function allocateName(db: Database.Database, companyId: string): string {
  const taken = takenFirstNames(db);

  let offset = 0;
  for (let i = 0; i < companyId.length; i += 1) {
    offset = (offset * 31 + companyId.charCodeAt(i)) >>> 0;
  }

  const pool = EMPLOYEE_NAME_POOL;
  for (let i = 0; i < pool.length; i += 1) {
    const name = pool[(offset + i) % pool.length]!;
    if (!taken.has(firstNameOf(name))) return name;
  }

  throw new NamePoolExhaustedError(taken.size, pool.length);
}
