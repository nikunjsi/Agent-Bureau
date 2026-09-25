import type Database from 'better-sqlite3';
import type { ActivityLog } from '../../db/activityLog';
import type { SupervisorRegistry } from '../../engine/supervisorRegistry';
import type { ControlChannelErrorCode } from '../../../shared/controlChannel/schemas';
import type { PricingTable } from '../../../shared/models/pricing';
import type { ChatBroadcaster } from '../../chat/chatBroadcaster';

/**
 * Everything a tool handler needs, threaded through from server.ts's
 * already-authenticated request — employeeId comes from the verified
 * bearer token (TokenRegistry.verify), never from the request body, the
 * same principle authorization.ts's own doc comment establishes for
 * resource ids.
 */
export interface ToolHandlerContext {
  db: Database.Database;
  activityLog: ActivityLog;
  /** §11.5.1's rate table, when the caller has one (X-22). Only
   *  `bureau_raise_checkpoint` uses it, and only to cost the one-shot call
   *  a near-miss duplicate check can make; absent means "cost not
   *  reported", never zero. */
  pricing?: PricingTable;
  employeeId: string;
  /** The client's own idempotency key (already deduplicated by
   * IdempotencyCache before a handler is ever invoked) — handlers that
   * create a durable row needing its own uniqueness (e.g. outbox messages)
   * derive it from this, scoped by employeeId, rather than minting a
   * second, unrelated key. */
  idempotencyKey: string;
  supervisorRegistry: SupervisorRegistry;
  /**
   * M10 — Electron's `userData` root, which is where §12.1's memory tree
   * lives. `bureau_propose_memory` and `bureau_read_memory` both need it,
   * and it is threaded through here for the same reason the IPC handlers
   * take it on their own context: a handler that called `app.getPath`
   * itself would be untestable outside a real Electron process, and the
   * whole handler layer is exercised from plain Node.
   *
   * The server already holds it (`ControlChannelServerOptions.baseDir`) for
   * the policy evaluator's `${company_home}` resolution — the same value,
   * not a second one.
   */
  baseDir: string;
  /**
   * M11 S2-0 — the one `ChatBroadcaster` `main()` builds, so a card a
   * handler posts (`bureau_report` today; the brief, the plan and intake's
   * questions next) reaches the open window when it is written, not at the
   * window's next re-hydrate. Absent only where no window exists (tests);
   * `appendChatMessage` then saves the row and skips the push.
   */
  chatBroadcaster?: ChatBroadcaster;
}

/**
 * A handler's own result — distinct from the wire-level ToolCallResponse
 * (server.ts wraps this into that envelope) so a handler never has to
 * import HTTP-shaped types. `message` on failure must be specific enough
 * for an agent to correct its next call, per §7.9's own explicit rule
 * ("VALIDATION ERRORS ARE READ BY AN AGENT, NOT A HUMAN") — never a bare
 * "invalid input".
 */
export type ToolHandlerResult =
  { ok: true; data: unknown } | { ok: false; code: ControlChannelErrorCode; message: string };

/**
 * A handler may be async (M8). Only one is — `bureau_raise_checkpoint`,
 * whose §9.2 duplicate check may make a one-shot HTTP call on a near-miss
 * (§28 M8 item 3). The alternative was to run duplicate detection
 * synchronously and drop the one-shot half, which §22.4 explicitly
 * provides for; but the near-miss band is exactly where a cheap call earns
 * its keep, and widening one union member is a smaller cost than deleting
 * a specified feature. server.ts awaits every handler uniformly, so a sync
 * handler is unaffected.
 */
export type ToolHandler = (
  ctx: ToolHandlerContext,
  rawArgs: unknown,
) => ToolHandlerResult | Promise<ToolHandlerResult>;
