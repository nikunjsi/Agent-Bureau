import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getRoleByFullKey } from '../db/repositories/roles';
import { insertEmployee, getEmployeeById, setEmployeeName } from '../db/repositories/employees';
import { getCompanyById } from '../db/repositories/companies';
import { isPackAvailable } from '../packs/revalidateInstalledPacks';
import { resolveModelTier, type ConfiguredModelTiers } from '../engine/modelTiers';
import { getSetting } from '../db/repositories/settings';
import { spriteVariantFor } from '../../shared/floor/sprites';
import { newId } from '../../shared/models/ids';
import { writeMemory } from '../memory/memoryStore';
import type { Employee } from '../../shared/models/employee';
import type { ModelTier } from '../../shared/models/enums';
import { allocateName, assertFirstNameAvailable } from './allocateName';
import { applyFloorLayout, collectLayoutInputs } from './persistFloorLayout';
import { generateFloorLayout } from './generateFloorLayout';

/**
 * §6.8 — "Hiring is instantiating a role as a named employee with a desk."
 *
 * ## This is a seam, and the shape is M5's
 *
 * §6.8: "The Director proposes hires when a plan needs a skill nobody has.
 * This is a `decision` checkpoint, **never automatic**, because each
 * employee costs money." No Director exists until M11 and no checkpoints
 * until M8, so the gate that must precede this call cannot be built yet.
 *
 * Rather than invent a trigger, this follows the acceptance-seam shape M5
 * used for `mergeAcceptedTask`: a plain exported function taking explicit
 * options, called directly by tests today, with the real caller named
 * here. When M11's Director raises the checkpoint and the user answers it,
 * the answered checkpoint calls THIS — nothing about the operation
 * changes, only what decides to invoke it.
 *
 * ## Ordering
 *
 * §6.8's own list: "allocate a desk in the department's room, pick a
 * sprite variant, create employee memory, emit `company.employee_hired`."
 *
 * The desk and the employee row are mutually dependent — desks record an
 * `employeeId`, and `employees.desk_x/desk_y` are NOT NULL — so the layout
 * is generated for the PROSPECTIVE roster first (the new person included),
 * their slot is read out of it, and the row is inserted with those
 * coordinates. Then the same layout is persisted. One transaction.
 *
 * CLAUDE.md #3: exactly one event. A hire also re-packs the floor, but it
 * is ONE user-visible action — `company.floor_rearranged` alongside would
 * be noise, so the desk and any floor growth ride in the hire's payload.
 *
 * The "animate the character walking in through the office door" half of
 * §6.8 is M12's; nothing here fakes it.
 */

export class RoleNotAvailableError extends Error {
  constructor(roleKey: string, reason: string) {
    super(`cannot hire into "${roleKey}": ${reason}`);
    this.name = 'RoleNotAvailableError';
  }
}

export class NoCompanyError extends Error {
  constructor() {
    super('no company exists yet — the setup wizard (§14.1, M13) creates one.');
    this.name = 'NoCompanyError';
  }
}

export interface HireEmployeeOptions {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly companyId: string;
  /** `pack:key` — `roles.full_key`. */
  readonly roleKey: string;
  /** Electron's userData root, for the employee's memory directory. */
  readonly baseDir: string;
  /**
   * §29/parking-lot: the Director may judge that THIS work needs a
   * different tier than the role's author chose. Absent means the role's
   * own `model_preference` (§7.5). No schema change — it is simply a
   * different preference list handed to the same resolver.
   */
  readonly modelTier?: ModelTier;
  /** Overrides the bundled name list. The Director supplies one, and it is
   * also the escape hatch when the pool is exhausted. */
  readonly name?: string;
}

export interface HireEmployeeResult {
  readonly employee: Employee;
  readonly desk: { x: number; y: number };
  readonly floorGrew: boolean;
}

export function hireEmployee(options: HireEmployeeOptions): HireEmployeeResult {
  const { db, activityLog, companyId, roleKey, baseDir } = options;

  const company = getCompanyById(db, companyId);
  if (company === null) throw new NoCompanyError();

  const role = getRoleByFullKey(db, roleKey);
  if (role === null) throw new RoleNotAvailableError(roleKey, 'no such role is installed');
  if (!role.enabled) throw new RoleNotAvailableError(roleKey, 'the role is disabled');

  // A pack withheld by §6.7 (validation failed, or the user switched it
  // off) must not be hireable — otherwise "disabled with a readable error"
  // stops at the Packs screen and the roles keep working anyway.
  const packKey = roleKey.split(':')[0]!;
  if (!isPackAvailable(db, packKey)) {
    throw new RoleNotAvailableError(roleKey, `its pack "${packKey}" is not available`);
  }

  const name = options.name ?? allocateName(db, companyId);
  // Checked for BOTH paths: an allocated name cannot collide by
  // construction, but a supplied one can, and this is the rule §6.8
  // states that `employees.name UNIQUE` does not enforce.
  assertFirstNameAvailable(db, name);

  const engine = role.engine_preference[0] ?? 'claude-code';

  /**
   * §7.5 — the employee's own tier choice, stored as a TIER and resolved
   * fresh at every spawn.
   *
   * This used to resolve a concrete model id here and write it to
   * `employees.model`, which `Supervisor.assign()` then ignored — the
   * M7→M4 boundary check's finding, where the same decision was made in
   * two places and only the second won. Hiring now records the CHOICE and
   * the Supervisor makes the decision, once.
   *
   * Resolution still happens below, but only so the hire event can report
   * which model this choice currently maps to. Nothing reads that value
   * back.
   */
  const modelTierOverride = options.modelTier ?? null;
  const preferenceForPreview = modelTierOverride ? [modelTierOverride] : role.model_preference;
  const resolvedPreview = resolveModelTier({
    modelPreference: preferenceForPreview,
    engineKey: engine,
    configured: getSetting(db, 'engines.modelTiers') as ConfiguredModelTiers,
  });

  const previousLayout = company.floor_layout;
  const heightBefore = previousLayout.grid.h;

  // The layout is generated for the roster INCLUDING this hire, so their
  // desk exists before the row that has to reference it does.
  // The id is minted here rather than by the repository because the sprite
  // variant is seeded from it (so appearance survives a rename and a
  // rehire) and the desk search below needs to recognise this employee in
  // a layout generated before the row exists.
  const employeeId = newId();
  const inputs = collectLayoutInputs(db, companyId);
  const prospective = generateFloorLayout({
    companyId,
    departments: inputs.departments,
    employees: [
      ...inputs.employees,
      { id: employeeId, departmentKey: role.department_key, isDirector: false },
    ],
    previousLayout: inputs.previousLayout,
  });

  const desk = prospective.layout.rooms
    .flatMap((room) => room.desks)
    .find((d) => d.employeeId === employeeId);
  if (desk === undefined) {
    throw new RoleNotAvailableError(
      roleKey,
      `department "${role.department_key}" has no free desk and its room could not be grown`,
    );
  }

  const hire = db.transaction(() => {
    const employee = insertEmployee(db, {
      id: employeeId,
      name,
      role_key: role.full_key,
      is_director: false,
      desk_x: desk.x,
      desk_y: desk.y,
      sprite_variant: spriteVariantFor(employeeId, role.sprite_key),
      status: 'off',
      engine,
      // NOT the resolved id. `employees.model` is a record the Supervisor
      // writes after it resolves; hiring records the CHOICE.
      model_tier_override: modelTierOverride,
      autonomy: role.autonomy_default,
      daily_budget_usd_micros: null,
    });
    // Re-run the generator now that the real id exists — the prospective
    // pass was only ever to find the coordinate.
    applyFloorLayout({ db, activityLog, companyId, emitEvent: false, reason: 'hire' });
    return employee;
  });
  const employee = hire();

  // §12.1's `employee/<id>/notes.md` — "an individual's working notes"
  // (§12.2), theirs to write freely. Created here so it exists from their
  // first turn rather than appearing on first write, and so a rehire has
  // something to come back to. Outside the transaction because it writes a
  // FILE: layer 1 is the source of truth and a filesystem write cannot be
  // rolled back by SQLite.
  writeMemory(db, {
    baseDir,
    scope: 'employee',
    scopeRef: employee.id,
    fileName: 'notes.md',
    title: `${employee.name}'s notes`,
    body:
      `# ${employee.name}'s notes\n\n` +
      `Role: ${role.title} (${role.full_key})\n\n` +
      `Working notes, written by ${employee.name} and kept across tasks.\n` +
      `Survives being fired and rehired (§6.8).\n`,
    source: 'observed',
  });

  const after = getCompanyById(db, companyId)!;
  const floorGrew = after.floor_layout.grid.h > heightBefore;

  activityLog.logEvent({
    actor: 'system',
    type: 'company.employee_hired',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: employee.id,
    checkpoint_id: null,
    payload: {
      companyId,
      name: employee.name,
      roleKey: role.full_key,
      department: role.department_key,
      desk: { x: employee.desk_x, y: employee.desk_y },
      spriteVariant: employee.sprite_variant,
      engine,
      // The stored choice, and what it maps to TODAY. The mapping is a
      // preview for the log only — it is re-resolved at every spawn, so
      // a settings or role change reaches this employee rather than
      // being frozen here.
      modelTierOverride,
      modelPreviewId: resolvedPreview?.modelId ?? null,
      modelPreviewTier: resolvedPreview?.tier ?? null,
      modelPreviewSource: resolvedPreview?.source ?? null,
      // A hire can grow the floor (§13.3 step 5). Recorded here rather
      // than as a second `company.floor_rearranged` event — one action,
      // one event.
      floorGrew,
    },
  });

  return { employee: getEmployeeById(db, employee.id)!, desk: { x: employee.desk_x, y: employee.desk_y }, floorGrew };
}

/**
 * §6.8: "The user can rename anyone." The first-name rule applies here too
 * — and this is where it actually bites, since a pool-allocated name
 * cannot collide by construction but a user-chosen one can.
 */
export function renameEmployee(options: {
  db: Database.Database;
  activityLog: ActivityLog;
  employeeId: string;
  name: string;
}): Employee {
  const { db, activityLog, employeeId, name } = options;
  const before = getEmployeeById(db, employeeId);
  if (before === null) throw new RoleNotAvailableError(employeeId, 'no such employee');

  assertFirstNameAvailable(db, name, employeeId);
  setEmployeeName(db, employeeId, name);

  activityLog.logEvent({
    actor: 'user',
    type: 'company.employee_renamed',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: employeeId,
    checkpoint_id: null,
    payload: { from: before.name, to: name },
  });

  return getEmployeeById(db, employeeId)!;
}
