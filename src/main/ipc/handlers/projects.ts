import { getProjectById, setProjectBudget } from '../../db/repositories/projects';
import { ipcOk, ipcError } from '../../../shared/ipc/envelope';
import { Projects as ProjectsSchemas } from '../../../shared/ipc/schemas/projects';
import { stub, type Handler, type HandlerContext } from './types';

function listAllProjects(ctx: HandlerContext) {
  const rows = ctx.db.prepare('SELECT id FROM projects ORDER BY created_at').all() as {
    id: string;
  }[];
  return rows.map((row) => getProjectById(ctx.db, row.id)).filter((p) => p !== null);
}

export const projectsHandlers: Record<string, Handler> = {
  list: (_input, ctx) => ipcOk({ items: listAllProjects(ctx) }),
  get: (input, ctx) => {
    const { id } = ProjectsSchemas.get.input.parse(input);
    return ipcOk({ item: getProjectById(ctx.db, id) });
  },
  // create/open/etc. need the Director's intake flow (M11) or, for
  // exportData/deleteData, a real export/delete pipeline (M13/M15) — not
  // just an INSERT/DELETE, since project data spans the DB, memory/, and
  // the worktree checkout.
  create: stub('M11'),
  open: stub('M11'),
  pause: stub('M11'),
  resume: stub('M11'),
  abandon: stub('M11'),
  // M6 session 2 built the four budget levels; this surface (the
  // project-level one) was left stubbed. CLAUDE.md invariant #3: commit
  // before the side effect, exactly one activity event — there is no
  // further side effect here (no employee to notify synchronously; the
  // next real budget check just reads the new value), so the event is
  // the whole second half.
  setBudget: (input, ctx) => {
    const { id, budgetUsdMicros } = ProjectsSchemas.setBudget.input.parse(input);
    const before = getProjectById(ctx.db, id);
    if (before === null) return ipcError('NOT_FOUND', `No project with id ${id}`);
    setProjectBudget(ctx.db, id, budgetUsdMicros);
    ctx.activityLog.logEvent({
      actor: 'user',
      type: 'project.budget_set',
      severity: 'info',
      project_id: id,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { beforeUsdMicros: before.budget_usd_micros, afterUsdMicros: budgetUsdMicros },
    });
    return ipcOk({ ok: true as const });
  },
  exportData: stub('M15'),
  deleteData: stub('M15'),
};
