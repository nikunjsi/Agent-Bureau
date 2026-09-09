import { shell } from 'electron';
import { EventSchema } from '../../../shared/models/event';
import { ipcOk } from '../../../shared/ipc/envelope';
import { Activity as ActivitySchemas } from '../../../shared/ipc/schemas/activity';
import { stub, type Handler, type HandlerContext } from './types';

function queryEvents(
  ctx: HandlerContext,
  projectId: string | null,
  type: string | null,
  since: string | null,
  limit: number,
) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (projectId !== null) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  if (type !== null) {
    clauses.push('type = ?');
    params.push(type);
  }
  if (since !== null) {
    clauses.push('ts >= ?');
    params.push(since);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  const rows = ctx.db
    .prepare(`SELECT * FROM events ${where} ORDER BY seq DESC LIMIT ?`)
    .all(...params);
  return rows.map((row) => EventSchema.parse(row));
}

export const activityHandlers: Record<string, Handler> = {
  query: (input, ctx) => {
    const { projectId, type, since, limit } = ActivitySchemas.query.input.parse(input);
    return ipcOk({ items: queryEvents(ctx, projectId, type, since, limit) });
  },
  openRawLog: async (_input, ctx) => {
    const err = await shell.openPath(ctx.dbPaths.activityLogPath);
    if (err) throw new Error(err);
    return ipcOk({ ok: true as const });
  },
  // A dedicated export format/destination is a real design decision, not
  // just re-running query() — leaving it to whichever milestone actually
  // needs it first rather than guessing now.
  //
  // That milestone is **M14**, not M9: §28 puts the Activity timeline (and
  // with it, exporting what the timeline shows) in M14 alongside the Board
  // and Inspector. M9 builds the chat and never touches this. Re-tagged
  // rather than left carrying a milestone that would have closed with this
  // stub still in it — the audit-#22 shape, where M3 and M5 both closed
  // with their own names still on a stub.
  export: stub('M14'),
};
