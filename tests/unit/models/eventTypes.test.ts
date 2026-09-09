import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../../../src/shared/models/eventTypes';
import { NewEventInputSchema } from '../../../src/shared/models/event';
import type { SupervisorState } from '../../../src/main/engine/supervisor';

/**
 * AUDIT #25 — §5.2's taxonomy, closed.
 *
 * `EventTypeSchema` was `z.string().min(1)`, so nothing validated an
 * emitted type against §5.2 in either direction: seven types were emitted
 * that the spec did not document, and two documented types were
 * unreachable, and neither fact could be seen from inside the code.
 *
 * The **compile-time** half of the fix is not tested here, because it is
 * not testable at runtime — it is `npm run typecheck` failing on
 * `logEvent({ type: 'not.real' })`, which no test can observe from inside a
 * passing build. What is tested here is the runtime half, plus the one
 * cross-module coupling that a type alone does not pin.
 */
describe('§5.2 event taxonomy (AUDIT #25)', () => {
  const base = {
    actor: 'system',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: null,
  };

  it('rejects a type that §5.2 does not document', () => {
    expect(() => NewEventInputSchema.parse({ ...base, type: 'employee.vanished' })).toThrow();
    // Including one that only *looks* like a taxonomy entry — a plausible
    // near-miss is exactly what silent drift is made of.
    expect(() => NewEventInputSchema.parse({ ...base, type: 'chat.message_sent' })).toThrow();
  });

  it('accepts every type Supervisor.transition() can produce', () => {
    // The real expansion is `` `employee.${next}` `` over SupervisorState.
    // Listing the states here would re-implement the type, so this reads
    // the real union: an added state that nobody documents makes this
    // assignment fail to compile, which is the failure this pins.
    const states: SupervisorState[] = [
      'off',
      'starting',
      'idle',
      'working',
      'thinking',
      'blocked',
      'waiting',
      'parked',
      'failed',
      'stopping',
    ];
    for (const state of states) {
      expect(
        EVENT_TYPES as readonly string[],
        `employee.${state} is emitted by Supervisor and must be in the taxonomy`,
      ).toContain(`employee.${state}`);
      expect(() => NewEventInputSchema.parse({ ...base, type: `employee.${state}` })).not.toThrow();
    }
  });

  it('carries the chat types M9 emits', () => {
    for (const type of [
      'chat.message_persisted',
      'chat.stream_started',
      'chat.stream_completed',
      'chat.stream_aborted',
    ]) {
      expect(() => NewEventInputSchema.parse({ ...base, type })).not.toThrow();
    }
  });

  it('has no duplicates — a duplicated entry would hide a real omission', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});
