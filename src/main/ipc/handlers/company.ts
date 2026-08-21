import { getCompanyById } from '../../db/repositories/companies';
import { ipcOk } from '../../../shared/ipc/envelope';
import { stub, type Handler, type HandlerContext } from './types';

/** Bureau is single-company for v1 (§4 has no concept of switching
 * companies) — the first (only) row in `companies`, or null before the
 * wizard (M13) has created one. */
function getTheOneCompany(ctx: HandlerContext) {
  const row = ctx.db.prepare('SELECT id FROM companies LIMIT 1').get() as { id: string } | undefined;
  return row ? getCompanyById(ctx.db, row.id) : null;
}

export const companyHandlers: Record<string, Handler> = {
  get: (_input, ctx) => ipcOk({ item: getTheOneCompany(ctx) }),
  // update/hire/fire/rename/moveDesk/departments all need packs (M7) or
  // the Director (M11) to make sense of "hire" beyond a raw DB insert —
  // stubbed rather than half-built.
  update: stub('M11'),
  hire: stub('M7'),
  fire: stub('M7'),
  rename: stub('M11'),
  moveDesk: stub('M12'),
  listDepartments: stub('M7'),
  addDepartment: stub('M7'),
  removeDepartment: stub('M7'),
};
