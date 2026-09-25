import { getPhaseById } from '../../db/repositories/phases';
import { ipcError, ipcOk } from '../../../shared/ipc/envelope';
import { acceptPhase } from '../../projects/phaseReview';
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
  /**
   * M11 S3-5a, §10.6 rule 5: the user accepts a phase in review, and the
   * Core merges its branch into `base_ref` — never moving the branch under
   * the user's own checkout (`acceptPhase`). A merge that cannot be made
   * safely raises a blocker checkpoint that says why, and is an error here
   * with the same words, so the card can show it.
   */
  accept: async (input, ctx) => {
    const { id } = PhasesSchemas.accept.input.parse(input);
    const result = await acceptPhase(
      {
        db: ctx.db,
        activityLog: ctx.activityLog,
        ...(ctx.directorTriggers ? { director: ctx.directorTriggers } : {}),
      },
      id,
    );
    if (result.kind === 'refused') return ipcError('CONFLICT', result.reason, { type: 'retry' });
    if (result.kind === 'blocked') return ipcError('CONFLICT', result.reason, { type: 'retry' });
    return ipcOk({ ok: true as const });
  },
  requestChanges: stub('M11'),
};
