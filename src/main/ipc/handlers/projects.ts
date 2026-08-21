import { getProjectById } from '../../db/repositories/projects';
import { ipcOk } from '../../../shared/ipc/envelope';
import { Projects as ProjectsSchemas } from '../../../shared/ipc/schemas/projects';
import { stub, type Handler, type HandlerContext } from './types';

function listAllProjects(ctx: HandlerContext) {
  const rows = ctx.db.prepare('SELECT id FROM projects ORDER BY created_at').all() as { id: string }[];
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
  setBudget: stub('M6'),
  exportData: stub('M15'),
  deleteData: stub('M15'),
};
