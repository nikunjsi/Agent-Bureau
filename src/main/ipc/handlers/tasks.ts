import { getTaskById } from '../../db/repositories/tasks';
import { ipcOk } from '../../../shared/ipc/envelope';
import { Tasks as TasksSchemas } from '../../../shared/ipc/schemas/tasks';
import { stub, type Handler, type HandlerContext } from './types';

function listTasks(ctx: HandlerContext, projectId: string | null) {
  const rows = (
    projectId === null
      ? ctx.db.prepare('SELECT id FROM tasks ORDER BY created_at').all()
      : ctx.db
          .prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY created_at')
          .all(projectId)
  ) as { id: string }[];
  return rows.map((row) => getTaskById(ctx.db, row.id)).filter((t) => t !== null);
}

export const tasksHandlers: Record<string, Handler> = {
  list: (input, ctx) => {
    const { projectId } = TasksSchemas.list.input.parse(input);
    return ipcOk({ items: listTasks(ctx, projectId) });
  },
  get: (input, ctx) => {
    const { id } = TasksSchemas.get.input.parse(input);
    return ipcOk({ item: getTaskById(ctx.db, id) });
  },
  // cancel/retry/reassign need the orchestrator (M3+) to actually act on a
  // running/queued task, not just flip a status column.
  cancel: stub('M3'),
  retry: stub('M3'),
  reassign: stub('M3'),
};
