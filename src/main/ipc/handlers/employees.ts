import { getEmployeeById } from '../../db/repositories/employees';
import { ipcOk } from '../../../shared/ipc/envelope';
import { Employees as EmployeesSchemas } from '../../../shared/ipc/schemas/employees';
import { stub, type Handler, type HandlerContext } from './types';

function listAllEmployees(ctx: HandlerContext) {
  const rows = ctx.db.prepare('SELECT id FROM employees ORDER BY hired_at').all() as { id: string }[];
  return rows.map((row) => getEmployeeById(ctx.db, row.id)).filter((e) => e !== null);
}

export const employeesHandlers: Record<string, Handler> = {
  list: (_input, ctx) => ipcOk({ items: listAllEmployees(ctx) }),
  get: (input, ctx) => {
    const { id } = EmployeesSchemas.get.input.parse(input);
    return ipcOk({ item: getEmployeeById(ctx.db, id) });
  },
  // Everything else needs a live supervisor/pty to act on (M3).
  pause: stub('M3'),
  resumeEmployee: stub('M3'),
  interrupt: stub('M3'),
  updateSettings: stub('M3'),
  takeControl: stub('M3'),
  releaseControl: stub('M3'),
  sendInput: stub('M3'),
  resizePty: stub('M3'),
};
