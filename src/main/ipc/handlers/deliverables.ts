import { getDeliverableById } from '../../db/repositories/deliverables';
import { ipcOk } from '../../../shared/ipc/envelope';
import { Deliverables as DeliverablesSchemas } from '../../../shared/ipc/schemas/deliverables';
import { stub, type Handler } from './types';

export const deliverablesHandlers: Record<string, Handler> = {
  list: (input, ctx) => {
    const { projectId } = DeliverablesSchemas.list.input.parse(input);
    const rows = ctx.db
      .prepare('SELECT id FROM deliverables WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as { id: string }[];
    return ipcOk({ items: rows.map((row) => getDeliverableById(ctx.db, row.id)).filter((d) => d !== null) });
  },
  get: (input, ctx) => {
    const { id } = DeliverablesSchemas.get.input.parse(input);
    return ipcOk({ item: getDeliverableById(ctx.db, id) });
  },
  accept: stub('M11'),
  reject: stub('M11'),
  openFolder: stub('M11'),
};
