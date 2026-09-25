import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getSoleCompany } from '../db/repositories/companies';
import { hireEmployee } from './hireEmployee';
import type { Checkpoint } from '../../shared/models/checkpoint';

/**
 * A hire proposal's checkpoint (M11 S3-3): raised by `bureau_hire_proposal`
 * only, which is the one writer of this `tool_name`, with the role's key in
 * `args_preview`. Recognised here, and nowhere else, as a hire.
 */
export const HIRE_PROPOSAL_TOOL = 'bureau_hire_proposal';
export const HIRE_PROPOSAL_OPTION_IDS = { hire: 'hire', notNow: 'not_now' } as const;

/** The role a checkpoint proposes to hire into, or `null` if it is not a
 *  hire proposal. */
export function proposedRole(checkpoint: Checkpoint): string | null {
  return checkpoint.tool_name === HIRE_PROPOSAL_TOOL && checkpoint.args_preview !== null
    ? checkpoint.args_preview
    : null;
}

export type ProposedHireResult =
  | { readonly kind: 'hired'; readonly employeeId: string }
  | { readonly kind: 'not_hired'; readonly reason: string };

/**
 * The user accepted a hire proposal: hire through the real `hireEmployee`
 * (§6.8 — its name, desk, memory and one `company.employee_hired`). Called by
 * `answerCheckpoint` after the answer is committed. A hire that cannot happen
 * (the role was uninstalled since) is returned as a reason, never thrown:
 * the answer stands either way.
 */
export function hireForAcceptedProposal(
  deps: {
    readonly db: Database.Database;
    readonly activityLog: ActivityLog;
    readonly baseDir: string;
  },
  roleKey: string,
): ProposedHireResult {
  const company = getSoleCompany(deps.db);
  if (company === null) return { kind: 'not_hired', reason: 'there is no company to hire into.' };
  try {
    const hired = hireEmployee({
      db: deps.db,
      activityLog: deps.activityLog,
      companyId: company.id,
      baseDir: deps.baseDir,
      roleKey,
    });
    return { kind: 'hired', employeeId: hired.employee.id };
  } catch (err) {
    return { kind: 'not_hired', reason: err instanceof Error ? err.message : String(err) };
  }
}
