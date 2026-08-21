import { getArtifactById } from '../../db/repositories/artifacts';
import { ipcOk } from '../../../shared/ipc/envelope';
import { Artifacts as ArtifactsSchemas } from '../../../shared/ipc/schemas/artifacts';
import type { Handler } from './types';

export const artifactsHandlers: Record<string, Handler> = {
  listForTask: (input, ctx) => {
    const { taskId } = ArtifactsSchemas.listForTask.input.parse(input);
    const rows = ctx.db
      .prepare('SELECT id FROM artifacts WHERE task_id = ? ORDER BY created_at')
      .all(taskId) as { id: string }[];
    return ipcOk({ items: rows.map((row) => getArtifactById(ctx.db, row.id)).filter((a) => a !== null) });
  },
  get: (input, ctx) => {
    const { id } = ArtifactsSchemas.get.input.parse(input);
    return ipcOk({ item: getArtifactById(ctx.db, id) });
  },
};
