import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { setCompanyFloorLayout, getCompanyById } from '../db/repositories/companies';
import { setDepartmentRoomRect, listDepartments } from '../db/repositories/departments';
import { listEmployees, setEmployeeDesk } from '../db/repositories/employees';
import { getRoleByFullKey } from '../db/repositories/roles';
import { emptyFloorLayout, type DroppedPin, type FloorLayout } from '../../shared/floor/layout';
import {
  generateFloorLayout,
  type DepartmentForLayout,
  type EmployeeForLayout,
} from './generateFloorLayout';

/**
 * §13.3 step 8 — "Persist the result in `companies.floor_layout` so it
 * never changes unexpectedly", plus the denormalised
 * `departments.room_rect` §5.1 also specifies and each employee's own
 * `desk_x`/`desk_y`.
 *
 * All in ONE transaction, because a layout that is half-applied is worse
 * than one that is stale: the company's own floor, each department's rect,
 * and every employee's desk would disagree about where anybody sits.
 */

export interface ApplyFloorLayoutResult {
  readonly layout: FloorLayout;
  readonly droppedPins: DroppedPin[];
}

/** Reads the generator's inputs out of the DB, in the shape it wants. */
export function collectLayoutInputs(
  db: Database.Database,
  companyId: string,
): {
  departments: DepartmentForLayout[];
  employees: EmployeeForLayout[];
  previousLayout: FloorLayout | null;
} {
  const departments = listDepartments(db, { enabledOnly: true }).map<DepartmentForLayout>((d) => ({
    key: d.key,
    name: d.name,
    preferredW: d.preferred_w,
    preferredH: d.preferred_h,
    props: d.theme?.props ?? [],
  }));

  // Active only — an archived employee has no desk (§6.8).
  const employees = listEmployees(db).map<EmployeeForLayout>((e) => ({
    id: e.id,
    // `employees.role_key` is `pack:key`; the department is the role's.
    departmentKey: getRoleByFullKey(db, e.role_key)?.department_key ?? null,
    isDirector: e.is_director,
  }));

  const company = getCompanyById(db, companyId);
  const previous = company?.floor_layout ?? null;
  // A company that has never been generated holds an empty layout, which
  // carries no pins — passing it is the same as passing null, and doing so
  // keeps the "previous layout" concept uniform for the caller.
  return { departments, employees, previousLayout: previous ?? null };
}

/**
 * Regenerates and persists. `emitEvent: false` is what a hire or a fire
 * passes: those are ONE user-visible action each and emit their own event
 * (`company.employee_hired` / `company.employee_fired`), so a second
 * `company.floor_rearranged` alongside would be noise — CLAUDE.md's
 * "exactly one activity event" per state change.
 *
 * Dropped pins are reported regardless of `emitEvent`: a caller that
 * suppressed the event still gets them back and puts them in its own
 * payload.
 */
export function applyFloorLayout(options: {
  db: Database.Database;
  activityLog: ActivityLog;
  companyId: string;
  emitEvent?: boolean;
  /** Recorded on the event so "why did the floor change" is answerable. */
  reason?: string;
}): ApplyFloorLayoutResult {
  const { db, activityLog, companyId } = options;
  const inputs = collectLayoutInputs(db, companyId);
  const { layout, droppedPins } = generateFloorLayout({ companyId, ...inputs });

  const write = db.transaction(() => {
    setCompanyFloorLayout(db, companyId, layout);
    for (const room of layout.rooms) {
      if (room.departmentKey === null) continue;
      setDepartmentRoomRect(db, room.departmentKey, room.rect);
    }
    for (const room of layout.rooms) {
      for (const desk of room.desks) {
        if (desk.employeeId === null) continue;
        setEmployeeDesk(db, desk.employeeId, desk.x, desk.y);
      }
    }
  });
  write();

  if (options.emitEvent === true || droppedPins.length > 0) {
    activityLog.logEvent({
      actor: 'system',
      type: 'company.floor_rearranged',
      severity: droppedPins.length > 0 ? 'warn' : 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: {
        companyId,
        reason: options.reason ?? 'regenerated',
        gridHeight: layout.grid.h,
        rooms: layout.rooms.length,
        // §13.3's "the layout persists" has a real limit, and this is
        // where it is recorded: a manual placement the re-pack could not
        // honour, naming the employee and both coordinates.
        //
        // SEAM, stated rather than implied: this is a durable record, not
        // a notification. Nothing surfaces it to a person until M9 has
        // somewhere to show it and M12 has a floor to show it on.
        droppedPins,
      },
    });
  }

  return { layout, droppedPins };
}

/** The layout a company currently holds, or an empty one if it has never
 * been generated. */
export function readFloorLayout(db: Database.Database, companyId: string): FloorLayout {
  return getCompanyById(db, companyId)?.floor_layout ?? emptyFloorLayout(companyId);
}
