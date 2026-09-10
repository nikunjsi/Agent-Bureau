import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { setCompanyFloorLayout } from '../db/repositories/companies';
import { setEmployeeDesk, getEmployeeById } from '../db/repositories/employees';
import type { FloorLayout } from '../../shared/floor/layout';
import { readFloorLayout } from './persistFloorLayout';
import { UserFacingError } from '../../shared/errors/userFacing';

/**
 * §13.3: "The user can drag employees between desks; the layout persists."
 *
 * The drag UI is M12. **The persistence is this**, and it is what makes
 * `generateFloorLayout` take the previous layout as an input: a placement
 * a person chose is marked `pinned`, and the next re-pack honours it
 * wherever the geometry still allows.
 *
 * Dropping onto an OCCUPIED desk swaps the two employees and pins both —
 * that is what "drag employees between desks" means, and refusing would
 * make the common rearrangement (two people trading places) impossible.
 * Dropping somewhere that is not a desk slot is refused: there is no
 * meaningful thing to persist.
 */

export class NotADeskError extends UserFacingError {
  constructor(x: number, y: number) {
    super(`(${x}, ${y}) is not a desk on this floor.`);
    this.name = 'NotADeskError';
  }
}

export class EmployeeHasNoDeskError extends UserFacingError {
  constructor(employeeId: string) {
    super(`employee ${employeeId} has no desk on the current floor layout.`);
    this.name = 'EmployeeHasNoDeskError';
  }
}

export interface MoveEmployeeToDeskResult {
  readonly layout: FloorLayout;
  /** The employee displaced by a swap, if any. */
  readonly swappedWithEmployeeId: string | null;
}

export function moveEmployeeToDesk(options: {
  db: Database.Database;
  activityLog: ActivityLog;
  companyId: string;
  employeeId: string;
  x: number;
  y: number;
}): MoveEmployeeToDeskResult {
  const { db, activityLog, companyId, employeeId, x, y } = options;

  if (getEmployeeById(db, employeeId) === null) {
    throw new EmployeeHasNoDeskError(employeeId);
  }

  const layout = readFloorLayout(db, companyId);

  let target: { roomIndex: number; deskIndex: number } | null = null;
  let current: { roomIndex: number; deskIndex: number } | null = null;
  layout.rooms.forEach((room, roomIndex) => {
    room.desks.forEach((desk, deskIndex) => {
      if (desk.x === x && desk.y === y) target = { roomIndex, deskIndex };
      if (desk.employeeId === employeeId) current = { roomIndex, deskIndex };
    });
  });

  if (target === null) throw new NotADeskError(x, y);
  if (current === null) throw new EmployeeHasNoDeskError(employeeId);

  const targetRef = target as { roomIndex: number; deskIndex: number };
  const currentRef = current as { roomIndex: number; deskIndex: number };

  const targetDesk = layout.rooms[targetRef.roomIndex]!.desks[targetRef.deskIndex]!;
  const currentDesk = layout.rooms[currentRef.roomIndex]!.desks[currentRef.deskIndex]!;
  const displaced = targetDesk.employeeId;

  if (displaced === employeeId) {
    // Already there. Still pin it — the user has now expressed an opinion
    // about a seat they previously just happened to occupy, and that is a
    // real state change worth persisting.
    targetDesk.pinned = true;
  } else {
    targetDesk.employeeId = employeeId;
    targetDesk.pinned = true;
    // A swap pins BOTH: the displaced employee did not choose to move, so
    // leaving them unpinned would let the next re-pack move them again.
    currentDesk.employeeId = displaced;
    currentDesk.pinned = displaced !== null;
  }

  const write = db.transaction(() => {
    setCompanyFloorLayout(db, companyId, layout);
    setEmployeeDesk(db, employeeId, targetDesk.x, targetDesk.y);
    if (displaced !== null && displaced !== employeeId) {
      setEmployeeDesk(db, displaced, currentDesk.x, currentDesk.y);
    }
  });
  write();

  activityLog.logEvent({
    actor: 'user',
    type: 'company.floor_rearranged',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: employeeId,
    checkpoint_id: null,
    payload: {
      companyId,
      reason: 'desk_moved',
      to: { x: targetDesk.x, y: targetDesk.y },
      swappedWithEmployeeId: displaced === employeeId ? null : displaced,
      droppedPins: [],
    },
  });

  return { layout, swappedWithEmployeeId: displaced === employeeId ? null : displaced };
}
