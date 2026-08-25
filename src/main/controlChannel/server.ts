import http from 'node:http';
import type { ActivityLog } from '../db/activityLog';
import { TokenRegistry } from './tokens';
import { PolicyHoldRegistry, DuplicateHoldError, type PolicyHoldVerdict } from './policyHoldRegistry';
import { evaluateInterimPolicy } from './policyEvaluator';
import { checkRequestOrigin } from './originCheck';
import { RateLimiter } from './rateLimiter';
import { IdempotencyCache } from './idempotencyCache';
import {
  PolicyCheckRequestSchema,
  AgentEventRequestSchema,
  ToolCallRequestSchema,
  type ControlChannelErrorCode,
  type ToolCallResponse,
} from '../../shared/controlChannel/schemas';

/** §7.9: the one concrete configured rate — enforced server-side, not trusted to the client. */
const DEFAULT_RATE_LIMITS: Readonly<Record<string, number>> = {
  bureau_report_status: 3_000,
};

const DEFAULT_BODY_CAP_BYTES = 1024 * 1024; // 1 MiB — generous for a tool call's args, small enough to bound abuse

/**
 * §7.10's evaluator is injectable, deliberately: production wiring uses
 * the real interim binary evaluator (never produces 'ask'); tests inject
 * one that returns 'ask' to drive the long-poll hold through the real
 * endpoint end to end, since nothing in production can reach that path
 * this session (see policyHoldRegistry.ts's own comment).
 */
export type PolicyEvaluatorFn = (
  request: { tool: string },
  employeeId: string,
) => Promise<'allow' | 'deny' | 'ask'>;

async function defaultEvaluator(request: { tool: string }): Promise<'allow' | 'deny' | 'ask'> {
  return evaluateInterimPolicy(request.tool);
}

export interface ControlChannelServerOptions {
  activityLog: ActivityLog;
  tokenRegistry: TokenRegistry;
  policyHoldRegistry?: PolicyHoldRegistry;
  evaluatePolicy?: PolicyEvaluatorFn;
  /** §7.10 default 30 — injectable so tests don't wait real minutes. */
  maxHoldMinutes?: number;
  bodyCapBytes?: number;
  rateLimitsByToolName?: Readonly<Record<string, number>>;
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
  private readonly activityLog: ActivityLog;
  private readonly tokenRegistry: TokenRegistry;
  private readonly policyHoldRegistry: PolicyHoldRegistry;
  private readonly evaluatePolicy: PolicyEvaluatorFn;
  private readonly maxHoldMs: number;
  private readonly bodyCapBytes: number;
  private readonly rateLimiter: RateLimiter;
  private readonly idempotencyCache = new IdempotencyCache();
  private port = 0;

  constructor(options: ControlChannelServerOptions) {
    this.activityLog = options.activityLog;
    this.tokenRegistry = options.tokenRegistry;
    this.policyHoldRegistry = options.policyHoldRegistry ?? new PolicyHoldRegistry();
    this.evaluatePolicy = options.evaluatePolicy ?? defaultEvaluator;
    this.maxHoldMs = (options.maxHoldMinutes ?? 30) * 60_000;
    this.bodyCapBytes = options.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;
    this.rateLimiter = new RateLimiter(options.rateLimitsByToolName ?? DEFAULT_RATE_LIMITS);
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
      await this.handlePolicyCheck(req, res, authed, body);
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/tool/')) {
      const toolName = decodeURIComponent(url.pathname.slice('/v1/tool/'.length));
      await this.handleToolCall(res, authed, toolName, body);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/event') {
      this.handleEvent(res, authed, body);
      return;
    }

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

  private async handlePolicyCheck(req: http.IncomingMessage, res: http.ServerResponse, authed: AuthedRequest, body: unknown): Promise<void> {
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

    const outcome = await this.evaluatePolicy({ tool: request.tool }, authed.employeeId);

    let verdict: PolicyHoldVerdict;
    if (outcome === 'allow' || outcome === 'deny') {
      verdict = outcome;
    } else {
      // 'ask' — hold. Nothing in this session's real evaluator ever
      // produces this; only an injected test evaluator does, to exercise
      // this path through the real endpoint (see the class doc comment).
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
      req.once('close', onClose);
      verdict = await holdPromise;
      req.off('close', onClose);
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

    this.respondJson(res, 200, { verdict, ruleId: null, reason: null });
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

    // Real bureau_* tool handlers are session 2's job (§7.9). This is the
    // real plumbing — auth, validation, idempotency, rate limiting — with
    // an honest NOT_IMPLEMENTED stub behind it, same discipline M2 used
    // for the ~85 IPC methods with no owning subsystem yet.
    const response: ToolCallResponse = {
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: `${toolName} has no handler yet — the real bureau_* tool implementations are M4 session 2's job` },
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

  // ---- /v1/event ----

  private handleEvent(res: http.ServerResponse, authed: AuthedRequest, body: unknown): void {
    const parsed = AgentEventRequestSchema.safeParse(body);
    if (!parsed.success) {
      this.respondError(res, 400, 'VALIDATION_FAILED', parsed.error.message);
      return;
    }
    const request = parsed.data;
    // The SAME logEvent() path M1 built — no parallel write path for
    // agent-originated events (M4 session 1 prompt, explicit). actor and
    // employee_id are server-derived from the authenticated token, never
    // taken from the request body — see schemas.ts's own comment on why.
    const entry = this.activityLog.logEvent({
      actor: `employee:${authed.employeeId}`,
      type: request.type,
      severity: request.severity,
      project_id: request.project_id,
      task_id: request.task_id,
      employee_id: authed.employeeId,
      checkpoint_id: request.checkpoint_id,
      payload: request.payload,
    });
    this.respondJson(res, 200, { ok: true, seq: entry.seq });
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
      req.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > this.bodyCapBytes) {
          req.destroy();
          reject(new BodyTooLargeError());
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
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

class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds the size cap');
  }
}
