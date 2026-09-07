import { describe, expect, it } from 'vitest';
import { groupPendingCheckpoints } from '../../../src/main/checkpoints/batching';
import type { Checkpoint } from '../../../src/shared/models/checkpoint';
import { newId } from '../../../src/shared/models/ids';

/**
 * §9.3 — "Five separate pings for one phase is the failure mode this
 * prevents."
 *
 * `groupPendingCheckpoints` is the decision; the message is M9's and the
 * Director that sends it is M11's. So these tests are the complete
 * statement of the grouping rule, and session 2's surfacing is its first
 * caller.
 */

const T0 = Date.parse('2026-09-07T12:00:00.000Z');
const WINDOW_SECONDS = 90;

function cp(overrides: Partial<Checkpoint> & { createdAtMs: number }): Checkpoint {
  const { createdAtMs, ...rest } = overrides;
  return {
    id: newId(),
    project_id: 'P1'.padEnd(26, '0'),
    task_id: null,
    employee_id: null,
    type: 'decision',
    urgency: 'soon',
    tool_call_id: null,
    tool_name: null,
    args_preview: null,
    title: 'A question',
    context: 'Because something happened.',
    options: [{ id: 'a', label: 'A', consequence: 'A happens.' }],
    preview: null,
    default_action: null,
    status: 'pending',
    answer: null,
    answered_by: null,
    expires_at: null,
    answered_at: null,
    created_at: new Date(createdAtMs).toISOString(),
    updated_at: new Date(createdAtMs).toISOString(),
    ...rest,
  } as Checkpoint;
}

const later = (ms: number) => ({ nowMs: T0 + ms, batchWindowSeconds: WINDOW_SECONDS });

describe('groupPendingCheckpoints (§9.3)', () => {
  it('never batches a blocking checkpoint — it is surfaced immediately', () => {
    const blocking = cp({ createdAtMs: T0, urgency: 'blocking' });
    const alsoBlocking = cp({ createdAtMs: T0 + 1000, urgency: 'blocking' });
    const result = groupPendingCheckpoints([blocking, alsoBlocking], later(0));

    expect(result.immediate.map((c) => c.id)).toEqual([blocking.id, alsoBlocking.id]);
    expect(result.batches).toEqual([]);
    expect(result.waiting).toEqual([]);
  });

  it('never batches a permission checkpoint — an agent is held waiting on it', () => {
    const permission = cp({
      createdAtMs: T0,
      type: 'permission',
      // Deliberately not `blocking`, so the exemption cannot be passing
      // for the urgency reason instead of the type reason.
      urgency: 'whenever',
      tool_call_id: 'call-1',
      tool_name: 'Bash',
    });
    const ordinary = cp({ createdAtMs: T0 + 1000 });
    const result = groupPendingCheckpoints([permission, ordinary], later(0));

    expect(result.immediate.map((c) => c.id)).toEqual([permission.id]);
    expect(result.waiting.map((c) => c.id)).toEqual([ordinary.id]);
  });

  it('holds a window open until batchWindowSeconds has passed since its FIRST member', () => {
    const first = cp({ createdAtMs: T0 });
    const second = cp({ createdAtMs: T0 + 30_000 });

    // 60s after the first — window still open.
    expect(groupPendingCheckpoints([first, second], later(60_000)).batches).toEqual([]);
    expect(groupPendingCheckpoints([first, second], later(60_000)).waiting).toHaveLength(2);

    // 91s after the first — closed, and the two go out together.
    const closed = groupPendingCheckpoints([first, second], later(91_000));
    expect(closed.batches).toHaveLength(1);
    expect(closed.batches[0]?.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it('measures the window from the first member, not the last — a trickle still closes', () => {
    // The bug this rules out: resetting the clock on each arrival means a
    // steady stream never closes and the user hears nothing at all, which
    // is worse than five pings.
    const arrivals = [0, 40_000, 80_000].map((offset) => cp({ createdAtMs: T0 + offset }));
    const result = groupPendingCheckpoints(arrivals, later(95_000));

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]).toHaveLength(3);
    expect(result.waiting).toEqual([]);
  });

  it('starts a new window once one checkpoint arrives beyond the previous window', () => {
    const first = cp({ createdAtMs: T0 });
    const second = cp({ createdAtMs: T0 + 30_000 });
    const late = cp({ createdAtMs: T0 + 200_000 });

    const result = groupPendingCheckpoints([first, second, late], later(400_000));
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]?.map((c) => c.id)).toEqual([first.id, second.id]);
    // A closed window with one member is not a batch — it is surfaced on
    // its own, which is what `settled` means.
    expect(result.settled.map((c) => c.id)).toEqual([late.id]);
  });

  it('does not merge two projects into one message', () => {
    // §9.3's failure mode is "five pings for one phase", and a phase
    // belongs to a project. Two projects' questions are two conversations.
    const a = cp({ createdAtMs: T0, project_id: 'PA'.padEnd(26, '0') });
    const b = cp({ createdAtMs: T0 + 1000, project_id: 'PB'.padEnd(26, '0') });

    const result = groupPendingCheckpoints([a, b], later(200_000));
    expect(result.batches).toEqual([]);
    expect(result.settled).toHaveLength(2);
  });

  it('keeps project-less checkpoints out of any real project group', () => {
    const orphan = cp({ createdAtMs: T0, project_id: null });
    const owned = cp({ createdAtMs: T0 + 1000, project_id: 'PA'.padEnd(26, '0') });

    const result = groupPendingCheckpoints([orphan, owned], later(200_000));
    expect(result.batches).toEqual([]);
    expect(result.settled).toHaveLength(2);
  });

  it('is order-independent — grouping follows created_at, not array order', () => {
    const first = cp({ createdAtMs: T0 });
    const second = cp({ createdAtMs: T0 + 30_000 });

    const result = groupPendingCheckpoints([second, first], later(200_000));
    expect(result.batches[0]?.map((c) => c.id)).toEqual([first.id, second.id]);
  });
});
