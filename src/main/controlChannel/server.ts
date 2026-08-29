import http from 'node:http';
import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { TokenRegistry } from './tokens';
import { PolicyHoldRegistry, DuplicateHoldError, type PolicyHoldVerdict } from './policyHoldRegistry';
import { createPolicyEvaluator, LOOP_DETECTED_RULE_ID } from './policy/policyEvaluator';
import { checkRequestOrigin } from './originCheck';
import { RateLimiter } from './rateLimiter';
import { IdempotencyCache } from './idempotencyCache';
import { EMPLOYEE_TOOL_HANDLERS, type ToolHandler, type ToolHandlerResult } from './toolHandlers';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import {
  PolicyCheckRequestSchema,
  ToolCallRequestSchema,
  type ControlChannelErrorCode,
  type ToolCallResponse,
} from '../../shared/controlChannel/schemas';
import type { PolicyEvaluatorFn } from '../../shared/policy/types';

/** §7.9: the one concrete configured rate — enforced server-side, not trusted to the client. */
const DEFAULT_RATE_LIMITS: Readonly<Record<string, number>> = {
  bureau_report_status: 3_000,
};

const DEFAULT_BODY_CAP_BYTES = 1024 * 1024; // 1 MiB — generous for a tool call's args, small enough to bound abuse

// `PolicyEvaluatorFn` itself now lives in src/shared/policy/types.ts (M6),
// re-exported here for anyone already importing it from this module —
// the real implementation is `createPolicyEvaluator` (src/main/
// controlChannel/policy/policyEvaluator.ts), which replaces M4's interim
// `evaluateInterimPolicy` through this exact seam, not alongside it.
export type { PolicyEvaluatorFn };

export interface ControlChannelServerOptions {
  db: Database.Database;
  activityLog: ActivityLog;
  tokenRegistry: TokenRegistry;
  supervisorRegistry: SupervisorRegistry;
  policyHoldRegistry?: PolicyHoldRegistry;
  evaluatePolicy?: PolicyEvaluatorFn;
  /** Electron's userData root (`app.getPath('userData')`) — same value
   * `main/index.ts` already passes to `getDbPaths`/`reconcile()`. Only
   * consulted when `evaluatePolicy` is not supplied, to build the real
   * default evaluator's `${bureau_state}` resolution. Tests that inject
   * their own `evaluatePolicy` (nearly all of them) never need this. */
  baseDir?: string;
  /** §7.10 default 30 — injectable so tests don't wait real minutes. */
  maxHoldMinutes?: number;
  bodyCapBytes?: number;
  rateLimitsByToolName?: Readonly<Record<string, number>>;
  /** Injectable so a test can register a fake tool name (e.g. a
   * rate-limited probe) without it being one of the real eight — defaults
   * to the real §7.9 employee tool set. */
  toolHandlers?: Readonly<Record<string, ToolHandler>>;
}

interface AuthedRequest {
  employeeId: string;
}

/**
 * §7.10 — the loopback control channel. `127.0.0.1:0` (never `0.0.0.0`),
 * three endpoints, bearer-token auth, long-poll on the policy check.
 */
export class ControlChannelServer {
  private readonly httpServer: http.Server;
  private readonly db: Database.Database;
  private readonly activityLog: ActivityLog;
  private readonly tokenRegistry: TokenRegistry;
  private readonly supervisorRegistry: SupervisorRegistry;
  private readonly policyHoldRegistry: PolicyHoldRegistry;
  private readonly evaluatePolicy: PolicyEvaluatorFn;
  private readonly maxHoldMs: number;
  private readonly bodyCapBytes: number;
  private readonly rateLimiter: RateLimiter;
  private readonly idempotencyCache = new IdempotencyCache();
  private readonly toolHandlers: Readonly<Record<string, ToolHandler>>;
  private port = 0;

  constructor(options: ControlChannelServerOptions) {
    this.db = options.db;
    this.activityLog = options.activityLog;
    this.tokenRegistry = options.tokenRegistry;
    this.supervisorRegistry = options.supervisorRegistry;
    this.policyHoldRegistry = options.policyHoldRegistry ?? new PolicyHoldRegistry();
    this.evaluatePolicy = options.evaluatePolicy ?? createPolicyEvaluator(this.db, options.baseDir ?? '');
    this.maxHoldMs = (options.maxHoldMinutes ?? 30) * 60_000;
    this.bodyCapBytes = options.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;
    this.rateLimiter = new RateLimiter(options.rateLimitsByToolName ?? DEFAULT_RATE_LIMITS);
    this.toolHandlers = options.toolHandlers ?? EMPLOYEE_TOOL_HANDLERS;
    this.httpServer = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(0, '127.0.0.1', () => {
        const address = this.httpServer.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('control channel server bound to an unexpected address shape'));
          return;
        }
        this.port = address.port;
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    // Graceful-path denial only — a real process kill bypasses this
    // entirely, which is exactly why the "Core dies mid-hold" guarantee
    // has to be a property of the CLIENT's own fail-closed behaviour
    // (§7.10: transport failure -> deny), not something this method can
    // provide. Still correct to deny cleanly-held requests on a graceful
    // stop, so it's done here too.
    for (const employeeId of this.tokenRegistry.listEmployeeIds()) {
      this.policyHoldRegistry.resolveAllForEmployee(employeeId, 'deny');
    }
    return new Promise((resolve, reject) => {
      this.httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  get assignedPort(): number {
    return this.port;
  }

  /**
   * The channel-never-throws boundary (same discipline as the IPC
   * router's own dispatchIpcCall) — anything unexpected thrown by the
   * real handler below becomes a well-formed INTERNAL_ERROR response
   * rather than an unhandled rejection that leaves the connection (and
   * the caller) hanging forever with no answer at all, which for
   * /v1/policy/check would be its own kind of fail-OPEN if a client ever
   * treated "never got a response" as anything other than deny.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await this.handleRequestInner(req, res);
    } catch (err) {
      if (!res.headersSent) {
        this.respondError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      } else {
        res.destroy();
      }
    }
  }

  private async handleRequestInner(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = checkRequestOrigin({
      remoteAddress: req.socket.remoteAddress,
      originHeader: req.headers.origin,
      hostHeader: req.headers.host,
      expectedPort: this.port,
    });
    if (!origin.ok) {
      this.logSecurityEvent('control.origin_rejected', null, { reason: origin.reason });
      this.respondError(res, 403, 'UNAUTHORIZED', 'origin rejected');
      return;
    }

    let body: unknown;
    try {
      body = await this.readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        this.respondError(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the size cap');
      } else {
        this.respondError(res, 400, 'VALIDATION_FAILED', 'request body is not valid JSON');
      }
      return;
    }

    const authed = this.authenticate(req);
    if (!authed) {
      this.respondError(res, 401, 'UNAUTHORIZED', 'missing, invalid, or revoked token');
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

    if (req.method === 'POST' && url.pathname === '/v1/policy/check') {
      await this.handlePolicyCheck(res, authed, body);
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/tool/')) {
      const toolName = decodeURIComponent(url.pathname.slice('/v1/tool/'.length));
      await this.handleToolCall(res, authed, toolName, body);
      return;
    }
    // /v1/event does NOT exist (M4 session 2 audit, §7.10): session 1 built
    // it speculatively, off the endpoint list alone, with no identified
    // caller. Every event that matters already has a more precise home —
    // /v1/policy/check logs tool.requested/allowed/denied itself,
    // /v1/tool/:name logs whatever each real handler decides, and the
    // adapter's own stream-json parsing (a separate channel entirely, not
    // this HTTP server) covers session/turn/tool.completed. An unused,
    // generically-typed, agent-authenticated write path into a
    // tamper-evident audit log is exactly the attack surface CLAUDE.md
    // invariant #4's layered-enforcement philosophy argues against — not
    // kept "just in case". Falls through to the generic 404 below.

    this.respondError(res, 404, 'NOT_IMPLEMENTED', `no such endpoint: ${req.method} ${url.pathname}`);
  }

  // ---- auth ----

  private authenticate(req: http.IncomingMessage): AuthedRequest | null {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      this.logSecurityEvent('control.token_rejected', null, { reason: 'missing or malformed Authorization header' });
      return null;
    }
    const token = header.slice('Bearer '.length);
    const employeeId = this.tokenRegistry.verify(token);
    if (!employeeId) {
      this.logSecurityEvent('control.token_rejected', null, { reason: 'token does not match a live employee' });
      return null;
    }
    return { employeeId };
  }

  // ---- /v1/policy/check ----

  private async handlePolicyCheck(res: http.ServerResponse, authed: AuthedRequest, body: unknown): Promise<void> {
    const parsed = PolicyCheckRequestSchema.safeParse(body);
    if (!parsed.success) {
      this.respondError(res, 400, 'VALIDATION_FAILED', parsed.error.message);
      return;
    }
    const request = parsed.data;

    this.activityLog.logEvent({
      actor: `employee:${authed.employeeId}`,
      type: 'tool.requested',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: authed.employeeId,
      checkpoint_id: null,
      payload: { callId: request.callId, tool: request.tool, preview: request.preview },
    });

    const result = await this.evaluatePolicy(
      { tool: request.tool, rawTool: request.rawTool, args: request.args, preview: request.preview },
      authed.employeeId,
    );

    let verdict: PolicyHoldVerdict;
    if (result.effect === 'allow' || result.effect === 'deny') {
      verdict = result.effect;
    } else {
      // 'ask' — hold. The real evaluator (§11.3) genuinely produces this
      // now (an autonomy-default fallback, or a loop-detector downgrade);
      // nothing before M8 can resolve a held 'ask' to anything but the
      // maxHoldMinutes timeout-to-deny below, which already satisfies
      // CLAUDE.md invariant #6 (fail closed) and #7 (a checkpoint timeout
      // never causes an irreversible action) — not rebuilt this session.
      let holdPromise: Promise<PolicyHoldVerdict>;
      try {
        holdPromise = this.policyHoldRegistry.create(request.callId, authed.employeeId, this.maxHoldMs);
      } catch (err) {
        if (err instanceof DuplicateHoldError) {
          // "The same employee issues a second policy check while one is
          // held" (M4 session 1 prompt) — answered: a REUSED callId is a
          // client bug (every real tool call mints its own), reported
          // cleanly rather than left to fall through to a generic 500.
          this.respondError(res, 400, 'VALIDATION_FAILED', err.message);
          return;
        }
        throw err;
      }
      let settledByClose = false;
      const onClose = (): void => {
        if (settledByClose) return;
        settledByClose = true;
        // The client (bureau-hook, running as this employee's process)
        // disconnected before the hold resolved — terminate it now
        // rather than leak the timer/connection until the full
        // maxHoldMinutes timeout. Nobody is left to read the verdict, so
        // the specific value doesn't matter; deny is the safe one.
        this.policyHoldRegistry.resolve(request.callId, 'deny');
      };
      // res.close, not req.close: by this point the request's own body
      // was already fully read (readJsonBody already saw 'end'), so
      // IncomingMessage's own 'close' says nothing further about the
      // connection. ServerResponse's 'close' is what Node documents for
      // "the underlying connection was terminated before the response
      // could be sent" — exactly the employee-dies-mid-hold signal.
      res.once('close', onClose);
      verdict = await holdPromise;
      res.off('close', onClose);
    }

    this.activityLog.logEvent({
      actor: 'system',
      type: verdict === 'allow' ? 'tool.allowed' : 'tool.denied',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: authed.employeeId,
      checkpoint_id: null,
      payload: { callId: request.callId, tool: request.tool },
    });

    if (result.ruleId === LOOP_DETECTED_RULE_ID) {
      this.activityLog.logEvent({
        actor: 'system',
        type: 'tool.loop_detected',
        severity: 'security',
        project_id: null,
        task_id: null,
        employee_id: authed.employeeId,
        checkpoint_id: null,
        payload: { callId: request.callId, tool: request.tool, reason: result.effect === 'ask' ? result.reason : null },
      });
    }

    // ruleId/reason reflect the rule that actually decided — for an 'ask'
    // that timed out to deny, that's still the ask rule's own id/reason
    // (the hold's timeout doesn't invent a new one), which is more useful
    // to the caller than a bare null.
    const reason = result.effect === 'deny' || result.effect === 'ask' ? result.reason : null;
    this.respondJson(res, 200, { verdict, ruleId: result.ruleId, reason: verdict === 'deny' ? reason : null });
  }

  // ---- /v1/tool/:name ----

  private async handleToolCall(res: http.ServerResponse, authed: AuthedRequest, toolName: string, body: unknown): Promise<void> {
    const parsed = ToolCallRequestSchema.safeParse(body);
    if (!parsed.success) {
      this.respondError(res, 400, 'VALIDATION_FAILED', parsed.error.message);
      return;
    }
    const { idempotencyKey } = parsed.data;

    const cached = this.idempotencyCache.get(authed.employeeId, idempotencyKey);
    if (cached) {
      this.respondToolResult(res, cached);
      return;
    }

    if (!this.rateLimiter.checkAndRecord(authed.employeeId, toolName)) {
      this.respondError(res, 429, 'RATE_LIMITED', `${toolName} was called too soon after the previous call`);
      return;
    }

    // §7.9's eight employee tools are real (M4 session 2, toolHandlers/).
    // Anything else (an unrecognised name, or the Director's 19 tools —
    // M11) gets the same honest NOT_IMPLEMENTED stub session 1 built —
    // never a crash, never silently treated as one of the eight.
    const handler = this.toolHandlers[toolName];
    const response: ToolCallResponse = handler
      ? toolHandlerResultToResponse(
          handler(
            {
              db: this.db,
              activityLog: this.activityLog,
              employeeId: authed.employeeId,
              idempotencyKey,
              supervisorRegistry: this.supervisorRegistry,
            },
            parsed.data.args,
          ),
        )
      : {
          ok: false,
          error: { code: 'NOT_IMPLEMENTED', message: `${toolName} is not a recognised Bureau tool at v1.` },
        };
    this.idempotencyCache.set(authed.employeeId, idempotencyKey, response);
    this.respondToolResult(res, response);
  }

  private respondToolResult(res: http.ServerResponse, response: ToolCallResponse): void {
    // The envelope itself carries ok:true/false; the transport-level status
    // stays 200 for any well-formed response, matching the IPC envelope's
    // own "never throw across the boundary" discipline — a non-200 here is
    // reserved for auth/validation/transport failures the caller can't
    // recover from by reading the body.
    this.respondJson(res, 200, response);
  }

  // ---- shared plumbing ----

  private logSecurityEvent(type: string, employeeId: string | null, payload: Record<string, unknown>): void {
    this.activityLog.logEvent({
      actor: 'system',
      type,
      severity: 'security',
      project_id: null,
      task_id: null,
      employee_id: employeeId,
      checkpoint_id: null,
      payload,
    });
  }

  private readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let overCap = false;
      req.on('data', (chunk: Buffer) => {
        if (overCap) return;
        receivedBytes += chunk.length;
        if (receivedBytes > this.bodyCapBytes) {
          overCap = true;
          // Deliberately NOT req.destroy() here: destroying the
          // IncomingMessage tears down the shared socket, which takes the
          // still-to-be-written 413 response down with it — the caller
          // would see a bare connection reset, indistinguishable from a
          // crash, instead of an actual 413 they can act on. Dropping the
          // last 'data' listener returns the stream to paused mode
          // (Node's own documented behaviour), which is enough to stop
          // buffering the oversized payload into memory without killing
          // the connection the response still needs.
          req.removeAllListeners('data');
          reject(new BodyTooLargeError());
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (overCap) return; // already rejected; a stray 'end' is a no-op against a settled promise anyway, but skip the parse

        if (chunks.length === 0) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      req.on('error', (err) => reject(err));
    });
  }

  private respondJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  private respondError(res: http.ServerResponse, status: number, code: ControlChannelErrorCode, message: string): void {
    this.respondJson(res, status, { ok: false, error: { code, message } });
  }
}

/** A ToolHandler's own result shape -> the wire-level ToolCallResponse
 * envelope. Kept as a free function (not a method) since it touches
 * nothing on the server instance — pure translation. */
function toolHandlerResultToResponse(result: ToolHandlerResult): ToolCallResponse {
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: { code: result.code, message: result.message } };
}

class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds the size cap');
  }
}
