import type Database from 'better-sqlite3';
import type { ActivityLog } from '../../db/activityLog';
import type { SupervisorRegistry } from '../../engine/supervisorRegistry';
import type { ControlChannelErrorCode } from '../../../shared/controlChannel/schemas';

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
  employeeId: string;
  /** The client's own idempotency key (already deduplicated by
   * IdempotencyCache before a handler is ever invoked) — handlers that
   * create a durable row needing its own uniqueness (e.g. outbox messages)
   * derive it from this, scoped by employeeId, rather than minting a
   * second, unrelated key. */
  idempotencyKey: string;
  supervisorRegistry: SupervisorRegistry;
}

/**
 * A handler's own result — distinct from the wire-level ToolCallResponse
 * (server.ts wraps this into that envelope) so a handler never has to
 * import HTTP-shaped types. `message` on failure must be specific enough
 * for an agent to correct its next call, per §7.9's own explicit rule
 * ("VALIDATION ERRORS ARE READ BY AN AGENT, NOT A HUMAN") — never a bare
 * "invalid input".
 */
export type ToolHandlerResult = { ok: true; data: unknown } | { ok: false; code: ControlChannelErrorCode; message: string };

export type ToolHandler = (ctx: ToolHandlerContext, rawArgs: unknown) => ToolHandlerResult;
