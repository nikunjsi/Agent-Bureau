import { getCheckpointById } from '../../db/repositories/checkpoints';
import { ipcOk } from '../../../shared/ipc/envelope';
import { Checkpoints as CheckpointsSchemas } from '../../../shared/ipc/schemas/checkpoints';
import { stub, type Handler, type HandlerContext } from './types';

function listPendingCheckpoints(ctx: HandlerContext) {
  const rows = ctx.db
    .prepare("SELECT id FROM checkpoints WHERE status = 'pending' ORDER BY created_at")
    .all() as { id: string }[];
  return rows.map((row) => getCheckpointById(ctx.db, row.id)).filter((c) => c !== null);
}

export const checkpointsHandlers: Record<string, Handler> = {
  listPending: (_input, ctx) => ipcOk({ items: listPendingCheckpoints(ctx) }),
  get: (input, ctx) => {
    const { id } = CheckpointsSchemas.get.input.parse(input);
    return ipcOk({ item: getCheckpointById(ctx.db, id) });
  },
  // Answering has to unblock whatever is actually waiting on it (M8's
  // router) — a bare status update would be a lie the moment M8 lands.
  answer: stub('M8'),
  answerPermission: stub('M8'),
};
