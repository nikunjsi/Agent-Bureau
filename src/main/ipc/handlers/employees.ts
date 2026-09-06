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
  // Everything else needs a live Supervisor to act on — the real, tested
  // mechanism these will call exists as of M3 session 3 (Supervisor.
  // takeControl/releaseControl/sendControlInput, TerminalBroadcaster's
  // read-only gate/coalescing/ring-buffer/multi-window fanout — see
  // src/main/engine/supervisor.ts and terminalBroadcaster.ts, both
  // covered by their own real tests). What's still missing is a live
  // per-employee Supervisor registry these handlers can look the caller's
  // `id` up in — that registry only has something in it once employees
  // actually get spawned (M7's hiring flow), which is why these are still
  // stubs and not this session's job to force into existence early.
  // resizePty additionally needs a resize() method added to EngineAdapter
  // (currently PtySession-internal only) — not added speculatively ahead
  // of the registry that would call it.
  //
  // M7 session 1 re-tag. The four control methods below are the Inspector's
  // (§14.5, M14): taking control of an employee's terminal, streaming
  // input to it, and resizing its PTY are all operations on a UI that does
  // not exist, and `resizePty` additionally needs a `resize()` on
  // EngineAdapter that is deliberately not added ahead of its caller.
  // Labelling them `M7` was wrong once M7 arrived and did not implement
  // them; a stub naming the wrong milestone is worse than one naming none,
  // because it reads as an oversight rather than a plan.
  takeControl: stub('M14'),
  releaseControl: stub('M14'),
  sendInput: stub('M14'),
  resizePty: stub('M14'),
  // These four stay M7: they need the live per-employee Supervisor
  // registry that the hiring flow populates, which is M7 session 2.
  pause: stub('M7'),
  resumeEmployee: stub('M7'),
  interrupt: stub('M7'),
  updateSettings: stub('M7'),
};
