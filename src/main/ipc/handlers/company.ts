import { getCompanyById, getSoleCompany } from '../../db/repositories/companies';
import { listDepartments } from '../../db/repositories/departments';
import { ipcOk, ipcError } from '../../../shared/ipc/envelope';
import { Company as CompanySchemas } from '../../../shared/ipc/schemas/company';
import { hireEmployee, renameEmployee } from '../../company/hireEmployee';
import { fireEmployee } from '../../company/fireEmployee';
import { moveEmployeeToDesk } from '../../company/moveEmployeeToDesk';
import { stub, type Handler, type HandlerContext } from './types';
import { UserFacingError } from '../../../shared/errors/userFacing';

/** Bureau is single-company for v1 (§4 has no concept of switching
 * companies) — the first (only) row in `companies`, or null before the
 * wizard (M13) has created one. */
function getTheOneCompany(ctx: HandlerContext) {
  return getSoleCompany(ctx.db);
}

/**
 * Every operation below needs a company to act on, and **nothing creates
 * one yet** — that is M13's setup wizard (§14.1). Saying so plainly beats
 * a crash three layers down, and it is the honest state of the product:
 * these handlers are real and reachable the moment a company exists.
 */
function requireCompanyId(ctx: HandlerContext): string | ReturnType<typeof ipcError> {
  const company = getTheOneCompany(ctx);
  if (company === null) {
    return ipcError('NOT_FOUND', 'No company has been set up yet. The setup wizard creates one.', {
      type: 'open_settings',
    });
  }
  return company.id;
}

/**
 * §6.8's hire, over IPC. The operation itself is
 * `src/main/company/hireEmployee.ts`; this is the transport.
 *
 * Note what this does NOT do: gate the hire behind a `decision`
 * checkpoint. §6.8 requires that gate ("never automatic, because each
 * employee costs money") and it belongs to M8's checkpoints plus M11's
 * Director. A renderer calling this today is a user explicitly asking to
 * hire, which is the same intent the checkpoint captures.
 */
const hire: Handler = (input, ctx) => {
  const parsed = CompanySchemas.hire.input.parse(input);
  const companyId = requireCompanyId(ctx);
  if (typeof companyId !== 'string') return companyId;

  try {
    const result = hireEmployee({
      db: ctx.db,
      activityLog: ctx.activityLog,
      companyId,
      baseDir: ctx.baseDir,
      roleKey: parsed.roleKey,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
    });
    return ipcOk(CompanySchemas.hire.output.parse({ item: result.employee }));
  } catch (err) {
    // AUDIT M0–M2 #16. The comment that used to sit here said these errors
    // "are already written for a person" — true of the errors it had in
    // mind (`FirstNameTakenError`, `NamePoolExhaustedError`,
    // `RoleNotAvailableError`) and untrue of the `catch`, which also
    // caught every SQLite failure and TypeError raised anywhere in the
    // `try` and showed its raw text to the user. §14.6: "'Error: ENOENT'
    // reaching the user is a bug."
    //
    // `UserFacingError` is now what opts a message in. Anything else is
    // rethrown for the router to log and translate — one translation, in
    // one place, rather than a second copy of it here (standing rule 6).
    if (err instanceof UserFacingError) {
      return ipcError('VALIDATION_FAILED', err.message, { type: 'retry' });
    }
    throw err;
  }
};

const fire: Handler = async (input, ctx) => {
  const { id } = CompanySchemas.fire.input.parse(input);
  const companyId = requireCompanyId(ctx);
  if (typeof companyId !== 'string') return companyId;

  try {
    await fireEmployee({ db: ctx.db, activityLog: ctx.activityLog, companyId, employeeId: id });
    return ipcOk(CompanySchemas.fire.output.parse({ ok: true }));
  } catch (err) {
    // Includes the Director refusal, whose message explains why rather
    // than just refusing.
    return ipcError('VALIDATION_FAILED', (err as Error).message);
  }
};

/** §6.8: "The user can rename anyone." */
const rename: Handler = (input, ctx) => {
  const parsed = CompanySchemas.rename.input.parse(input);
  try {
    renameEmployee({
      db: ctx.db,
      activityLog: ctx.activityLog,
      employeeId: parsed.id,
      name: parsed.name,
    });
    return ipcOk(CompanySchemas.rename.output.parse({ ok: true }));
  } catch (err) {
    // AUDIT M0–M2 #16 — same reasoning as `hire` above.
    if (err instanceof UserFacingError) {
      return ipcError('VALIDATION_FAILED', err.message, { type: 'retry' });
    }
    throw err;
  }
};

/** §13.3: "The user can drag employees between desks; the layout
 * persists." The drag is M12's; this is the persistence. */
const moveDesk: Handler = (input, ctx) => {
  const parsed = CompanySchemas.moveDesk.input.parse(input);
  const companyId = requireCompanyId(ctx);
  if (typeof companyId !== 'string') return companyId;

  try {
    moveEmployeeToDesk({
      db: ctx.db,
      activityLog: ctx.activityLog,
      companyId,
      employeeId: parsed.id,
      x: parsed.deskX,
      y: parsed.deskY,
    });
    return ipcOk(CompanySchemas.moveDesk.output.parse({ ok: true }));
  } catch (err) {
    return ipcError('VALIDATION_FAILED', (err as Error).message);
  }
};

export const companyHandlers: Record<string, Handler> = {
  get: (_input, ctx) => ipcOk({ item: getTheOneCompany(ctx) }),
  hire,
  fire,
  rename,
  moveDesk,
  // X-5 / §6.7: a department from a pack that failed validation is not
  // offered — hiring into it is refused anyway, and showing it is offering it.
  listDepartments: (_input, ctx) =>
    ipcOk(
      CompanySchemas.listDepartments.output.parse({
        items: listDepartments(ctx.db, { fromAvailablePacksOnly: true }),
      }),
    ),
  // `update` renames the company itself and moves its home path — company
  // identity, which the setup wizard owns (§14.1).
  update: stub('M13'),
  // Adding or removing a DEPARTMENT from a company is composition, not
  // pack installation: installing a pack already creates its department
  // rows (M7 session 1), and §6.4's `default_hires` ("who exists when this
  // department is FIRST ADDED") describes a separate later act. Deciding
  // which departments a company has belongs to the setup wizard, and
  // removing one has to answer what happens to the people in it — a
  // product question this milestone has no reason to settle.
  //
  // Re-tagged from `M7` rather than left: M7 arrived and did not implement
  // these, and a stub naming the wrong milestone reads as an oversight.
  addDepartment: stub('M13'),
  removeDepartment: stub('M13'),
};

// Re-exported so `getCompanyById` stays reachable for callers that already
// import it from here.
export { getCompanyById };
