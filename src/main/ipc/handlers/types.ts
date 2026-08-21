import type Database from 'better-sqlite3';
import type { ActivityLog } from '../../db/activityLog';
import type { DbPaths } from '../../db/paths';
import { ipcNotImplemented } from '../../../shared/ipc/envelope';

export interface HandlerContext {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly dbPaths: DbPaths;
}

/**
 * Every handler's real signature. Takes `unknown` — already validated by
 * the router against the method's own schema by the time this runs, but
 * stored generically across ~109 methods of very different shapes, so a
 * "real" handler re-derives its precise type with that same schema's own
 * `.parse()` rather than an unchecked cast (see handlers/settings.ts for
 * the pattern). Stub handlers ignore the input entirely.
 */
export type Handler = (input: unknown, ctx: HandlerContext) => unknown | Promise<unknown>;

/** Every method M2 does not implement returns this, consistently, with
 * the milestone that owns it — never fake behavior. */
export function stub(owningMilestone: string): Handler {
  return () => ipcNotImplemented(owningMilestone);
}
