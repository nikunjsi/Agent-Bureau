import http from 'node:http';
import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { TokenRegistry } from './tokens';
import type { PricingTable } from '../../shared/models/pricing';
import {
  PolicyHoldRegistry,
  DuplicateHoldError,
  type PolicyHoldVerdict,
} from './policyHoldRegistry';
import { createPermissionCheckpoint } from '../checkpoints/permissionCheckpoint';
import { recordCheckpointAnswer } from '../db/repositories/checkpoints';
import { getSetting } from '../db/repositories/settings';
import { createPolicyEvaluator, LOOP_DETECTED_RULE_ID } from './policy/policyEvaluator';
import { checkRequestOrigin } from './originCheck';
import { RateLimiter } from './rateLimiter';
import { IdempotencyCache } from './idempotencyCache';
import {
  isKnownBureauTool,
  toolHandlersFor,
  type ToolHandler,
  type ToolHandlerResult,
} from './toolHandlers';
import { getEmployeeById } from '../db/repositories/employees';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import type { ChatBroadcaster } from '../chat/chatBroadcaster';
import type { EventType } from '../../shared/models/eventTypes';
import {
  HookSessionStartRequestSchema,
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
  /** §11.5.1's rate table, threaded to the one-shot call a checkpoint's
   *  near-miss confirmation can make (X-22). Absent means "cost not
   *  reported", which is what a caller with no table honestly knows. */
  pricing?: PricingTable;
  /** M11 S2-0: the one chat broadcaster `main()` builds, handed to every
   *  tool handler so the cards they post are pushed to the open window. */
  chatBroadcaster?: ChatBroadcaster;
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
 * three endpoints (policy check, tool call, and M11's hook-liveness report),
 * bearer-token auth, long-poll on the policy check.
 */
export class ControlChannelServer {
  private readonly httpServer: http.Server;
  private readonly db: Database.Database;
  private readonly activityLog: ActivityLog;
  private readonly tokenRegistry: TokenRegistry;
  private readonly supervisorRegistry: SupervisorRegistry;
  private readonly policyHoldRegistry: PolicyHoldRegistry;
  private readonly evaluatePolicy: PolicyEvaluatorFn;
  private readonly maxHoldMinutes: number;
  private readonly maxHoldMs: number;
  private readonly bodyCapBytes: number;
  private readonly rateLimiter: RateLimiter;
  private readonly idempotencyCache = new IdempotencyCache();
  /** Set only when a caller (a test) supplies one: otherwise the set is
   *  chosen per request from who is calling (M11 row S1-12a). */
  private readonly toolHandlersOverride: Readonly<Record<string, ToolHandler>> | null;
  /** Electron userData. M10: the memory tools need it (§12.1 lives under
   *  it), and it is the SAME value the default policy evaluator already
   *  resolves `${bureau_state}` from — held once rather than passed twice. */
  private readonly baseDir: string;
  /** §11.5.1's rates, or undefined when the caller has none (X-22). */
  private readonly pricing: PricingTable | undefined;
  /** M11 S2-0 — see `ControlChannelServerOptions.chatBroadcaster`. */
  private readonly chatBroadcaster: ChatBroadcaster | undefined;
  private port = 0;

  constructor(options: ControlChannelServerOptions) {
    this.db = options.db;
    this.activityLog = options.activityLog;
    this.tokenRegistry = options.tokenRegistry;
    this.pricing = options.pricing;
    this.chatBroadcaster = options.chatBroadcaster;
    this.supervisorRegistry = options.supervisorRegistry;
    this.policyHoldRegistry = options.policyHoldRegistry ?? new PolicyHoldRegistry();
    this.baseDir = options.baseDir ?? '';
    this.evaluatePolicy =
      options.evaluatePolicy ??
      createPolicyEvaluator(this.db, this.baseDir, this.supervisorRegistry);
    // §16.1 owns this default, not this file. Before M8 it was hardcoded
    // `?? 30` here, a second copy of the registry's own value that could
    // silently disagree with it the moment a user changed the setting.
    this.maxHoldMinutes =
      options.maxHoldMinutes ?? getSetting(this.db, 'permissions.maxHoldMinutes');
    this.maxHoldMs = this.maxHoldMinutes * 60_000;
    this.bodyCapBytes = options.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;
    this.rateLimiter = new RateLimiter(options.rateLimitsByToolName ?? DEFAULT_RATE_LIMITS);
    this.toolHandlersOverride = options.toolHandlers ?? null;
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
        this.respondError(
          res,
          500,
          'INTERNAL_ERROR',
          err instanceof Error ? err.message : String(err),
        );
      } else {
        res.destroy();
      }
    }
  }

  private async handleRequestInner(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
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
    if (req.method === 'POST' && url.pathname === '/v1/hook/session-start') {
      this.handleHookSessionStart(res, authed, body);
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

    this.respondError(
      res,
      404,
      'NOT_IMPLEMENTED',
      `no such endpoint: ${req.method} ${url.pathname}`,
    );
  }

  // ---- auth ----

  private authenticate(req: http.IncomingMessage): AuthedRequest | null {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      this.logSecurityEvent('control.token_rejected', null, {
        reason: 'missing or malformed Authorization header',
      });
      return null;
    }
    const token = header.slice('Bearer '.length);
    const employeeId = this.tokenRegistry.verify(token);
    if (!employeeId) {
      this.logSecurityEvent('control.token_rejected', null, {
        reason: 'token does not match a live employee',
      });
      return null;
    }
    return { employeeId };
  }

  // ---- /v1/policy/check ----

  private async handlePolicyCheck(
    res: http.ServerResponse,
    authed: AuthedRequest,
    body: unknown,
  ): Promise<void> {
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
      {
        tool: request.tool,
        rawTool: request.rawTool,
        args: request.args,
        preview: request.preview,
      },
      authed.employeeId,
    );

    let verdict: PolicyHoldVerdict;
    if (result.effect === 'allow' || result.effect === 'deny') {
      verdict = result.effect;
    } else {
      // 'ask' — hold the agent, then raise the permission checkpoint a
      // person answers (§9.1, §7.10). M4 built the hold and said plainly
      // that nothing could resolve it to anything but the timeout-to-deny
      // "before M8"; this is M8, and the checkpoint is that resolver.
      //
      // ## Why the hold is created FIRST, and why that is not a #3 violation
      //
      // `create()` is the request's last piece of VALIDATION: a reused
      // callId is a client bug and must be rejected, and rejecting it
      // after writing a checkpoint row would leave an orphan row behind
      // for a request that was refused. Validation before state change is
      // the normal order.
      //
      // Invariant #3 governs a durable state change preceding an external
      // side effect. A hold is neither: it is an in-process promise that
      // leaves no trace, and if this process dies the hold dies with it —
      // there is nothing to reconcile. The genuine side effect here is the
      // agent being allowed to proceed, and that still happens only after
      // the row exists and someone answers it.
      let checkpointId: string | null = null;
      let holdPromise: Promise<PolicyHoldVerdict>;
      try {
        holdPromise = this.policyHoldRegistry.create(
          request.callId,
          authed.employeeId,
          this.maxHoldMs,
        );
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

      try {
        checkpointId = createPermissionCheckpoint(this.db, this.activityLog, {
          employeeId: authed.employeeId,
          callId: request.callId,
          tool: request.tool,
          rawTool: request.rawTool ?? null,
          argsPreview: request.preview ?? null,
          reason: result.reason,
          // One number, resolved once: the row's own expires_at is
          // computed from these same minutes, so the card can never
          // promise the user more time than the hold will actually wait.
          holdMinutes: this.maxHoldMinutes,
        }).id;
      } catch (err) {
        // No row means no human can ever answer, so this hold would do
        // nothing but stall the agent for maxHoldMinutes and then deny.
        // Denying NOW is the same outcome, sooner, and with a record —
        // CLAUDE.md invariant #6, and the honest version of it: fail
        // closed AND say why, rather than fail closed by exhaustion.
        this.policyHoldRegistry.resolve(request.callId, 'deny');
        this.logSecurityEvent('tool.denied', authed.employeeId, {
          callId: request.callId,
          tool: request.tool,
          reason: `could not raise the permission checkpoint: ${(err as Error).message}`,
        });
        this.respondJson(res, 200, {
          verdict: 'deny',
          ruleId: result.ruleId,
          reason:
            'This action needed your approval, but the request to ask you could not be recorded.',
        });
        return;
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

      // The hold has settled. Close the row out unless a person already
      // did — `answerPermissionCheckpoint` is the other resolver, and
      // `recordCheckpointAnswer`'s CAS is what makes "whoever got there
      // first wins" true rather than "whoever wrote last wins". A row
      // left pending here would show the user a question about a tool
      // call that is already over.
      if (checkpointId !== null) {
        this.closeUnansweredPermissionCheckpoint(checkpointId, verdict);
      }
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
        payload: {
          callId: request.callId,
          tool: request.tool,
          reason: result.effect === 'ask' ? result.reason : null,
        },
      });
      // §11.5, item 10 — the circuit breaker's repeated-tool-call
      // trigger. Session 1's own loop detector is CONSUMED here, not
      // rebuilt: this is the one real thing the breaker adds on top of
      // the signal it already produces.
      this.supervisorRegistry.get(authed.employeeId)?.noteLoopDetected();
    }

    // ruleId/reason reflect the rule that actually decided — for an 'ask'
    // that timed out to deny, that's still the ask rule's own id/reason
    // (the hold's timeout doesn't invent a new one), which is more useful
    // to the caller than a bare null.
    const reason = result.effect === 'deny' || result.effect === 'ask' ? result.reason : null;
    this.respondJson(res, 200, {
      verdict,
      ruleId: result.ruleId,
      reason: verdict === 'deny' ? reason : null,
    });
  }

  // ---- /v1/hook/session-start ----

  /**
   * M11 hook liveness (§7.6): the `SessionStart` hook saying it ran, with
   * this employee's token. The Supervisor waits for it before an employee
   * starts, because a registered hook is not proof of a running one.
   *
   * Not a general event path (see the `/v1/event` note above): it takes one
   * id, writes nothing to the log, and changes nothing durable. The start it
   * unblocks records the session on `employee.started`, which is the state
   * change. Every turn's CLI fires the hook too, and those reports land here
   * as no-ops unless a start is waiting.
   */
  private handleHookSessionStart(
    res: http.ServerResponse,
    authed: AuthedRequest,
    body: unknown,
  ): void {
    const parsed = HookSessionStartRequestSchema.safeParse(body);
    if (!parsed.success) {
      this.respondError(res, 400, 'VALIDATION_FAILED', parsed.error.message);
      return;
    }
    this.supervisorRegistry.get(authed.employeeId)?.noteHookSessionStarted(parsed.data.sessionId);
    this.respondJson(res, 200, { ok: true });
  }

  // ---- /v1/tool/:name ----

  private async handleToolCall(
    res: http.ServerResponse,
    authed: AuthedRequest,
    toolName: string,
    body: unknown,
  ): Promise<void> {
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
      this.respondError(
        res,
        429,
        'RATE_LIMITED',
        `${toolName} was called too soon after the previous call`,
      );
      return;
    }

    // M11 row S1-12a: which tools exist depends on who is asking. The
    // Director and an employee do different jobs, and a tool belonging to
    // the other one is refused as an authorization failure — with the
    // security event that records it — rather than answered, or reported
    // as "not built" when it is built for somebody else.
    const caller = getEmployeeById(this.db, authed.employeeId);
    const handlers = this.toolHandlersOverride ?? toolHandlersFor(caller?.is_director === true);
    const handler = handlers[toolName];
    if (!handler && isKnownBureauTool(toolName)) {
      this.activityLog.logEvent({
        actor: 'system',
        type: 'control.authorization_rejected',
        severity: 'security',
        project_id: null,
        task_id: null,
        employee_id: authed.employeeId,
        checkpoint_id: null,
        payload: { tool: toolName, reason: 'wrong_role_for_tool' },
      });
      const refusal: ToolCallResponse = {
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message:
            caller?.is_director === true
              ? `${toolName} is an employee's tool: the Director has no task of its own to report on.`
              : `${toolName} is the Director's tool, and you are not the Director.`,
        },
      };
      this.idempotencyCache.set(authed.employeeId, idempotencyKey, refusal);
      this.respondToolResult(res, refusal);
      return;
    }
    const response: ToolCallResponse = handler
      ? toolHandlerResultToResponse(
          await handler(
            {
              db: this.db,
              activityLog: this.activityLog,
              employeeId: authed.employeeId,
              idempotencyKey,
              supervisorRegistry: this.supervisorRegistry,
              baseDir: this.baseDir,
              ...(this.pricing === undefined ? {} : { pricing: this.pricing }),
              ...(this.chatBroadcaster === undefined
                ? {}
                : { chatBroadcaster: this.chatBroadcaster }),
            },
            parsed.data.args,
          ),
        )
      : {
          ok: false,
          error: {
            code: 'NOT_IMPLEMENTED',
            message: `${toolName} is not a recognised Bureau tool at v1.`,
          },
        };
    this.idempotencyCache.set(authed.employeeId, idempotencyKey, response);
    this.respondToolResult(res, response);
  }

  /**
   * The permission checkpoint's other ending: nobody answered, so the
   * hold decided — by timing out (`deny`, per `PolicyHoldRegistry`'s own
   * fail-closed timer) or by the employee's process disconnecting.
   *
   * Recorded as `auto_resolved`, not `answered`: no person chose this,
   * and `checkpoint.auto_resolved` is the event §5.2 has for exactly that.
   * The CAS means a user who answered a moment earlier keeps their answer
   * and this is a no-op — which is also why nothing is emitted when it
   * changes nothing.
   */
  private closeUnansweredPermissionCheckpoint(
    checkpointId: string,
    verdict: PolicyHoldVerdict,
  ): void {
    const won = recordCheckpointAnswer(this.db, checkpointId, {
      status: 'auto_resolved',
      answer: { optionId: verdict === 'allow' ? 'allow_once' : 'deny' },
      answeredBy: 'system:hold_expired',
    });
    if (!won) return;
    this.activityLog.logEvent({
      actor: 'system',
      type: 'checkpoint.auto_resolved',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: checkpointId,
      payload: { type: 'permission', appliedDefault: 'deny', verdict },
    });
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

  private logSecurityEvent(
    // AUDIT #25: `string` here was the one place the taxonomy could be
    // sidestepped even after the enum landed — a helper widening its own
    // parameter re-opens exactly what the closed type exists to shut.
    type: EventType,
    employeeId: string | null,
    payload: Record<string, unknown>,
  ): void {
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
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  private respondError(
    res: http.ServerResponse,
    status: number,
    code: ControlChannelErrorCode,
    message: string,
  ): void {
    this.respondJson(res, status, { ok: false, error: { code, message } });
  }
}

/** A ToolHandler's own result shape -> the wire-level ToolCallResponse
 * envelope. Kept as a free function (not a method) since it touches
 * nothing on the server instance — pure translation. */
function toolHandlerResultToResponse(result: ToolHandlerResult): ToolCallResponse {
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: { code: result.code, message: result.message } };
}

class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds the size cap');
  }
}
