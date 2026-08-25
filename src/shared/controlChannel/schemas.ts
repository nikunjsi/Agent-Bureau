import { z } from 'zod';
import { IdSchema } from '../models/ids';

/**
 * §7.10 — the control channel `bureau-hook`/`bureau-tools` (M4 session 2)
 * talk to. One schema file, imported by both the server (this session) and
 * the real clients (next session) — "sharing Zod schemas with the Core, not
 * parallel definitions that can drift" (M4 session 1 prompt). Distinct from
 * `src/shared/ipc/`, which is the Electron main<->renderer channel — this
 * is a plain loopback HTTP server, a different transport with different
 * concerns (bearer tokens, not `senderFrame`; a closed error-code set of
 * its own, not IPC's).
 */

/** The contents of `<stateDir>/control.json` (§7.10). */
export const ControlJsonSchema = z.object({
  port: z.number().int().positive(),
  token: z.string().min(1),
  employeeId: IdSchema,
});
export type ControlJson = z.infer<typeof ControlJsonSchema>;

/** A closed set, mirroring the discipline `src/shared/ipc/envelope.ts` established — never a bare string. */
export const ControlChannelErrorCodeSchema = z.enum([
  'UNAUTHORIZED', // missing/malformed/unknown/stale token
  'VALIDATION_FAILED',
  'NOT_IMPLEMENTED', // §7.9's real tools are session 2 — this session's /v1/tool/:name is real plumbing, no real tool handlers yet
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
]);
export type ControlChannelErrorCode = z.infer<typeof ControlChannelErrorCodeSchema>;

export const ControlChannelErrorSchema = z.object({
  code: ControlChannelErrorCodeSchema,
  message: z.string().min(1),
});

/**
 * POST /v1/policy/check — one call per PreToolUse hook invocation. Mirrors
 * AgentEvent's own `tool.requested` fields (minus `t`) rather than
 * inventing a parallel shape, since this genuinely is that event crossing
 * the process boundary.
 */
export const PolicyCheckRequestSchema = z.object({
  callId: z.string().min(1),
  tool: z.string().min(1),
  rawTool: z.string().min(1),
  args: z.unknown(),
  preview: z.string(),
});
export type PolicyCheckRequest = z.infer<typeof PolicyCheckRequestSchema>;

/**
 * The response is always a RESOLVED verdict — never 'ask'. A pending 'ask'
 * is exactly what the long-poll hold is *for* (§7.10): the HTTP response
 * only goes out once resolved to a final allow/deny, matching §7.1.1's
 * own PolicyVerdict, which excludes 'ask' for the identical reason
 * ("'ask' is resolved to allow/deny by the Core before reaching the
 * adapter"). Deliberately not importing that type directly — it lives in
 * src/shared/engine/ and describes the adapter-facing shape; this is the
 * wire shape for a different boundary, kept distinct on purpose (same
 * discipline as PolicyVerdict vs. §11.3's Verdict staying two types).
 */
export const PolicyCheckResponseSchema = z.object({
  verdict: z.enum(['allow', 'deny']),
  ruleId: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
});
export type PolicyCheckResponse = z.infer<typeof PolicyCheckResponseSchema>;

/**
 * POST /v1/tool/:name — the tool name is the URL param; the body carries
 * everything else. `idempotencyKey` matches §7.9's message-path discipline:
 * a retried call (bureau-tools timing out and retrying) with the same key
 * must not re-execute — see policyHoldRegistry.ts's sibling, the
 * idempotency cache in server.ts.
 */
export const ToolCallRequestSchema = z.object({
  idempotencyKey: z.string().min(1),
  args: z.unknown(),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

export const ToolCallResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: ControlChannelErrorSchema }),
]);
export type ToolCallResponse = z.infer<typeof ToolCallResponseSchema>;

// No POST /v1/event. Session 1 defined AgentEventRequestSchema/
// EventResponseSchema for it speculatively, off the endpoint list in
// §7.10 alone; M4 session 2 audited who would actually call it and found
// no legitimate caller — every event that matters already has a more
// precise home (see server.ts's own comment at the route-dispatch site).
// Deleted rather than left exported-but-unused: a schema for an endpoint
// that doesn't exist reads as documentation of a real capability, which
// this isn't. If a genuine need for agent-originated freeform events
// surfaces later, design its allow-list against that real need, not
// speculatively ahead of one — same actor-from-token principle this draft
// already got right, worth keeping when it's rebuilt.
