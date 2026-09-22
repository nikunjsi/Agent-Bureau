import { z } from 'zod';
import {
  CheckpointTypeSchema,
  CheckpointUrgencySchema,
  MemoryScopeSchema,
  OutboxMessageKindSchema,
} from '../../../shared/models/enums';
import { CheckpointOptionSchema } from '../../../shared/models/checkpoint';

/**
 * §7.9's employee tool arg tables, as real Zod schemas — one file, shared
 * between server.ts's own validation (session 1's "sharing Zod schemas
 * with the Core, not parallel definitions that can drift" discipline
 * extended to the tool layer) and bureau-tools' own MCP tool registration
 * (M4 session 2), so the two can never quietly disagree about what a valid
 * call looks like.
 *
 * A small, deliberate urgency enum shared by the two tools that take one
 * (`bureau_ask_director`, and reused nowhere else) — not
 * CheckpointUrgencySchema, whose three values ('blocking'/'soon'/
 * 'whenever') describe how urgently a *human* must answer a checkpoint, a
 * different question from how urgently a *message* to the Director should
 * be handled.
 */
export const MessageUrgencySchema = z.enum(['low', 'normal', 'high']);
export type MessageUrgency = z.infer<typeof MessageUrgencySchema>;

// ---- bureau_report_status ----

export const ReportStatusArgsSchema = z.object({
  status_detail: z.string().min(1).max(120),
});

// ---- bureau_task_done ----

// A deliberately small subset of NewArtifactInput: task_id/employee_id are
// server-derived (never agent-suppliable — the same closed-at-the-design-
// level principle authorization.ts's own doc comment explains), and
// content_sha256/bytes/pinned are either computed server-side or not yet
// meaningful for an agent-reported artifact at M4.
export const TaskDoneArtifactSchema = z.object({
  kind: z.string().min(1),
  title: z.string().min(1),
  path: z.string().nullable().default(null),
  content: z.string().nullable().default(null),
  mime: z.string().nullable().default(null),
});
export type TaskDoneArtifactInput = z.infer<typeof TaskDoneArtifactSchema>;

export const TaskDoneArgsSchema = z.object({
  summary: z.string().min(1),
  verified: z.array(z.string()).default([]),
  not_verified: z.array(z.string()).default([]),
  artifacts: z.array(TaskDoneArtifactSchema).default([]),
});

// ---- bureau_task_blocked ----

export const TaskBlockedArgsSchema = z.object({
  reason: z.string().min(1),
  tried: z.array(z.string()).default([]),
  needs: z.string().min(1),
});

// ---- bureau_ask_director ----

export const AskDirectorArgsSchema = z.object({
  question: z.string().min(1),
  context: z.string().default(''),
  urgency: MessageUrgencySchema.default('normal'),
});

// ---- bureau_raise_checkpoint ----
// The consequence-per-option rule (§9/CLAUDE.md #8) lives in exactly one
// place: `CheckpointOptionSchema`, imported below. This file used to
// re-declare a near-copy while its own comment claimed it was 'reused
// directly rather than re-declared here' — the comment was the intent and
// the code was not. M8 makes them agree. (The copy was also subtly weaker
// than it looked: the shared schema's `consequence` was a bare
// `z.string()`, which accepts '', so the 'rejected by validation' rule was
// false on the shared path until M8 tightened it to .min(1).)

export const RaiseCheckpointArgsSchema = z.object({
  type: CheckpointTypeSchema,
  title: z.string().min(1),
  context: z.string().min(1),
  // `reversible` is omitted rather than forwarded (X-9). An agent-raised
  // checkpoint carries no `default_action` — this schema does not accept one
  // and the handler never sets one — so nothing here can time out into an
  // option, and a reversibility an agent asserted would decide nothing while
  // looking like it did. The Core's own authors state it, where it governs a
  // real expiry.
  options: z.array(CheckpointOptionSchema.omit({ reversible: true })).min(1),
  preview: z.unknown().optional(),
  urgency: CheckpointUrgencySchema,
});

// ---- bureau_send_message ----

export const SendMessageArgsSchema = z.object({
  to: z.string().min(1),
  kind: OutboxMessageKindSchema,
  subject: z.string().nullable().default(null),
  body: z.string().min(1),
});

// ---- bureau_propose_memory ----

export const ProposeMemoryArgsSchema = z.object({
  scope: MemoryScopeSchema,
  path: z.string().min(1),
  content: z.string().min(1),
  rationale: z.string().min(1),
});

// ---- bureau_read_memory ----

export const ReadMemoryArgsSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(50).default(10),
});

/**
 * §7.9's `bureau_report` — a Director tool (M11 row S1-12a).
 *
 * `payload` is a plain object here and is validated against the kind's own
 * card schema inside the handler (`ReportPayloadSchema` /
 * `SummaryPayloadSchema`). A discriminated union would say it better, but
 * the MCP registration reads each schema's `.shape`, which a union has
 * none of — so the second half of the validation happens where the kind is
 * known, and the agent gets the same structured refusal either way.
 */
export const ReportArgsSchema = z.object({
  kind: z.enum(['report', 'summary']),
  body: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
