import { getBriefById } from '../../db/repositories/briefs';
import { ipcOk } from '../../../shared/ipc/envelope';
import { Brief as BriefSchemas } from '../../../shared/ipc/schemas/brief';
import { stub, type Handler } from './types';

export const briefHandlers: Record<string, Handler> = {
  get: (input, ctx) => {
    const { projectId } = BriefSchemas.get.input.parse(input);
    const row = ctx.db
      .prepare('SELECT id FROM briefs WHERE project_id = ? ORDER BY version DESC LIMIT 1')
      .get(projectId) as { id: string } | undefined;
    return ipcOk({ item: row ? getBriefById(ctx.db, row.id) : null });
  },
  // approve/requestEdit/saveEdit are the Director's intake conversation
  // (M11) acting on the result — not a bare row update.
  approve: stub('M11'),
  requestEdit: stub('M11'),
  saveEdit: stub('M11'),
};
