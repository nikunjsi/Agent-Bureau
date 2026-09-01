import type Database from 'better-sqlite3';
import type { ActivityLog } from '../../db/activityLog';
import type { DbPaths } from '../../db/paths';
import type { PricingTable } from '../../../shared/models/pricing';
import { ipcNotImplemented } from '../../../shared/ipc/envelope';

export interface HandlerContext {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly dbPaths: DbPaths;
  /** Loaded once at startup (`main/index.ts`, same `loadPricingYaml(
   * resolvePricingYamlPath())` call session 2's own comment already named
   * as the real seam) — M6 session 3's `costsHandlers.pricingTable` is
   * its first real reader. Threaded through `ctx` rather than resolved
   * per-call so the handler never touches `app.isPackaged` itself (this
   * repo's own convention, per `resourcePaths.test.ts`, is that
   * `app.isPackaged`-gated code is only exercised through a real packaged
   * exe — resolving the path fresh on every IPC call would make this
   * handler untestable in the plain integration suite for no benefit). */
  readonly pricing: PricingTable;
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
