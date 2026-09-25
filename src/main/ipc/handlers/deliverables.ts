import { getDeliverableById } from '../../db/repositories/deliverables';
import { ipcError, ipcOk } from '../../../shared/ipc/envelope';
import {
  acceptDeliverable,
  deliverableFolder,
  rejectDeliverable,
} from '../../projects/deliverableActions';
import { openInShell } from './openInShell';
import { Deliverables as DeliverablesSchemas } from '../../../shared/ipc/schemas/deliverables';
import { type Handler } from './types';

export const deliverablesHandlers: Record<string, Handler> = {
  list: (input, ctx) => {
    const { projectId } = DeliverablesSchemas.list.input.parse(input);
    const rows = ctx.db
      .prepare('SELECT id FROM deliverables WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as { id: string }[];
    return ipcOk({
      items: rows.map((row) => getDeliverableById(ctx.db, row.id)).filter((d) => d !== null),
    });
  },
  get: (input, ctx) => {
    const { id } = DeliverablesSchemas.get.input.parse(input);
    return ipcOk({ item: getDeliverableById(ctx.db, id) });
  },
  /** M11 S3-5b, §8.5.2: the user's verdict on a deliverable in review. */
  accept: (input, ctx) => {
    const { id } = DeliverablesSchemas.accept.input.parse(input);
    const result = acceptDeliverable({ db: ctx.db, activityLog: ctx.activityLog }, id);
    if (result.kind === 'refused') return ipcError('CONFLICT', result.reason, { type: 'retry' });
    return ipcOk({ ok: true as const });
  },
  reject: (input, ctx) => {
    const { id, feedback } = DeliverablesSchemas.reject.input.parse(input);
    const result = rejectDeliverable(
      {
        db: ctx.db,
        activityLog: ctx.activityLog,
        ...(ctx.directorTriggers ? { director: ctx.directorTriggers } : {}),
      },
      { deliverableId: id, feedback },
    );
    if (result.kind === 'refused') return ipcError('CONFLICT', result.reason, { type: 'retry' });
    return ipcOk({ ok: true as const });
  },
  /** §8.7: "a button to open the folder". Where the deliverable is, else the
   *  project's folder; opened through the one `openInShell`. */
  openFolder: async (input, ctx) => {
    const { id } = DeliverablesSchemas.openFolder.input.parse(input);
    const folder = deliverableFolder(ctx.db, id);
    if (folder === null) {
      return ipcError('NOT_FOUND', 'That deliverable no longer exists.', { type: 'retry' });
    }
    return openInShell(folder, 'the folder it is in');
  },
};
