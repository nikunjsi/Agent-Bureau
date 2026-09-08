import { getPhaseById } from '../../db/repositories/phases';
import { ipcOk } from '../../../shared/ipc/envelope';
import { Phases as PhasesSchemas } from '../../../shared/ipc/schemas/phases';
import { stub, type Handler } from './types';

export const phasesHandlers: Record<string, Handler> = {
  list: (input, ctx) => {
    const { planId } = PhasesSchemas.list.input.parse(input);
    const rows = ctx.db
      .prepare('SELECT id FROM phases WHERE plan_id = ? ORDER BY ordinal')
      .all(planId) as { id: string }[];
    return ipcOk({
      items: rows.map((row) => getPhaseById(ctx.db, row.id)).filter((p) => p !== null),
    });
  },
  get: (input, ctx) => {
    const { id } = PhasesSchemas.get.input.parse(input);
    return ipcOk({ item: getPhaseById(ctx.db, id) });
  },
  submitReview: stub('M11'),
  accept: stub('M11'),
  requestChanges: stub('M11'),
};
