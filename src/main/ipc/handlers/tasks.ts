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
  // cancel/retry/reassign need the orchestrator to actually act on a
  // running/queued task, not just flip a status column. Tagged M3 until
  // AUDIT M0–M2 #25, which told users this was coming in a milestone that
  // had already shipped. They are user actions from §28 M14 item 1's task
  // detail; the assignment loop they act on is M11's (item 10), so M11 may
  // well make them real first — if it does, delete these lines.
  cancel: stub('M14'),
  retry: stub('M14'),
  reassign: stub('M14'),
};
