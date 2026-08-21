import { getPlanById } from '../../db/repositories/plans';
import { ipcOk } from '../../../shared/ipc/envelope';
import { Plan as PlanSchemas } from '../../../shared/ipc/schemas/plan';
import { stub, type Handler } from './types';

export const planHandlers: Record<string, Handler> = {
  get: (input, ctx) => {
    const { projectId } = PlanSchemas.get.input.parse(input);
    const row = ctx.db
      .prepare('SELECT id FROM plans WHERE project_id = ? ORDER BY version DESC LIMIT 1')
      .get(projectId) as { id: string } | undefined;
    return ipcOk({ item: row ? getPlanById(ctx.db, row.id) : null });
  },
  approve: stub('M11'),
  requestEdit: stub('M11'),
};
