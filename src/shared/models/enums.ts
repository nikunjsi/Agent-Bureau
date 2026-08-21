import { z } from 'zod';

// Every status/kind/type enum from §5.1, in one place so a value is spelled
// the same way everywhere it appears (a table's own column and any other
// table's reference to "that kind of value").

export const EmployeeStatusSchema = z.enum([
  'off',
  'starting',
  'idle',
  'working',
  'thinking',
  'waiting',
  'blocked',
  'parked',
  'stopping',
  'failed',
]);
export type EmployeeStatus = z.infer<typeof EmployeeStatusSchema>;

export const EngineModeSchema = z.enum(['structured', 'pty']);

export const AutonomySchema = z.enum(['ask', 'guided', 'autonomous']);

export const ProjectKindSchema = z.enum(['software', 'document', 'research', 'mixed']);

export const ProjectStageSchema = z.enum([
  'intake',
  'brief',
  'planning',
  'executing',
  'review',
  'delivered',
  'paused',
  'abandoned',
]);

export const VersionedDocStatusSchema = z.enum([
  'draft',
  'awaiting_approval',
  'approved',
  'superseded',
]);

export const PhaseStatusSchema = z.enum(['pending', 'active', 'review', 'done', 'skipped']);

export const TaskStatusSchema = z.enum([
  'queued',
  'assigned',
  'running',
  'blocked',
  'review',
  'done',
  'failed',
  'cancelled',
]);

export const WorktreeStatusSchema = z.enum(['free', 'leased', 'dirty', 'pruning']);

export const ConversationStatusSchema = z.enum(['active', 'archived']);

export const MessageAuthorSchema = z.enum(['user', 'director', 'system']);

export const ConversationMessageKindSchema = z.enum([
  'text',
  'question',
  'brief',
  'plan',
  'report',
  'checkpoint',
  'summary',
  'error',
]);

export const ConversationMessageStatusSchema = z.enum([
  'streaming',
  'complete',
  'aborted',
  'error',
]);

export const OutboxMessageKindSchema = z.enum([
  'handoff',
  'question',
  'answer',
  'finding',
  'status',
]);

export const OutboxMessageStatusSchema = z.enum([
  'pending',
  'delivered',
  'consumed',
  'failed',
  'dead_letter',
]);

export const CheckpointTypeSchema = z.enum([
  'decision',
  'approval',
  'review',
  'information',
  'blocker',
  'permission',
]);

export const CheckpointUrgencySchema = z.enum(['blocking', 'soon', 'whenever']);

export const CheckpointStatusSchema = z.enum([
  'pending',
  'answered',
  'expired',
  'auto_resolved',
  'cancelled',
]);

export const DeliverableTypeSchema = z.enum([
  'repository',
  'document',
  'report',
  'dataset',
  'design',
  'other',
]);

export const DeliverableStatusSchema = z.enum(['draft', 'in_review', 'accepted', 'rejected']);

export const MemoryScopeSchema = z.enum(['company', 'project', 'role', 'employee', 'user']);

export const MemorySourceSchema = z.enum(['user_stated', 'observed', 'imported']);

export const UsageSourceSchema = z.enum(['turn', 'oneshot']);

export const RoleDeliverableKindSchema = z.enum([
  'code',
  'document',
  'report',
  'design',
  'analysis',
]);
