import { describe, expect, it } from 'vitest';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { ConversationSchema } from '../../../src/shared/models/conversation';
import { ConversationMessageSchema } from '../../../src/shared/models/conversationMessage';
import { OutboxMessageSchema } from '../../../src/shared/models/message';
import { CheckpointSchema, NewCheckpointInputSchema } from '../../../src/shared/models/checkpoint';

describe('ConversationSchema', () => {
  it('parses director_state_data JSON and allows a null director_state', () => {
    const now = nowIso();
    const parsed = ConversationSchema.parse({
      id: newId(),
      company_id: newId(),
      project_id: null,
      title: 'New chat',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: JSON.stringify({ pendingAnswers: [] }),
      status: 'active',
      created_at: now,
      updated_at: now,
    });
    expect(parsed.director_state_data).toEqual({ pendingAnswers: [] });
  });
});

describe('ConversationMessageSchema', () => {
  it('parses every documented kind and status', () => {
    const now = nowIso();
    const base = {
      id: newId(),
      conversation_id: newId(),
      project_id: null,
      author: 'director' as const,
      body: 'hello',
      payload: null,
      checkpoint_id: null,
      seq: null,
      read_at: null,
      created_at: now,
      updated_at: now,
    };
    for (const kind of ['text', 'question', 'brief', 'plan', 'report', 'checkpoint', 'summary', 'error']) {
      expect(ConversationMessageSchema.parse({ ...base, kind, status: 'complete' }).kind).toBe(kind);
    }
    for (const status of ['streaming', 'complete', 'aborted', 'error']) {
      expect(ConversationMessageSchema.parse({ ...base, kind: 'text', status }).status).toBe(status);
    }
  });
});

describe('OutboxMessageSchema', () => {
  it('requires updated_at even though only §5.1s own listing omits it (finding #1)', () => {
    const now = nowIso();
    const parsed = OutboxMessageSchema.parse({
      id: newId(),
      idempotency_key: 'k1',
      from_addr: 'director',
      to_addr: 'employee:abc',
      resolved_employee_id: null,
      task_id: null,
      thread_id: null,
      kind: 'handoff',
      priority: 50,
      subject: null,
      body: 'do the thing',
      status: 'pending',
      attempts: 0,
      next_attempt_at: null,
      delivered_at: null,
      consumed_at: null,
      created_at: now,
      updated_at: now,
    });
    expect(parsed.updated_at).toBe(now);
  });
});

describe('CheckpointSchema', () => {
  const now = nowIso();
  const base = {
    id: newId(),
    project_id: null,
    task_id: null,
    employee_id: null,
    type: 'decision' as const,
    urgency: 'soon' as const,
    tool_call_id: null,
    tool_name: null,
    args_preview: null,
    title: 'Pick a database',
    context: 'Need your call',
    options: null,
    preview: null,
    status: 'pending' as const,
    answer: null,
    answered_by: null,
    answered_at: null,
    created_at: now,
    updated_at: now,
  };

  it('accepts a null default_action when expires_at is also null (never expires)', () => {
    expect(() => CheckpointSchema.parse({ ...base, default_action: null, expires_at: null })).not.toThrow();
  });

  it('accepts a non-null default_action with a non-null expires_at', () => {
    expect(() =>
      CheckpointSchema.parse({ ...base, default_action: 'cancel', expires_at: now }),
    ).not.toThrow();
  });

  it('rejects a non-null expires_at with a null default_action — §5.1s CHECK, mirrored in Zod', () => {
    expect(() => CheckpointSchema.parse({ ...base, default_action: null, expires_at: now })).toThrow();
  });

  it('the same rule applies to the insert-input schema', () => {
    expect(() =>
      NewCheckpointInputSchema.parse({
        type: 'blocker',
        urgency: 'blocking',
        title: 'x',
        context: 'x',
        default_action: null,
        expires_at: now,
      }),
    ).toThrow();
  });
});
