import { describe, expect, it } from 'vitest';
import { runShutdownSequence } from '../../src/main/shutdownSequence';

/**
 * AUDIT #16 / invariant #3 — quit must not close the DB out from under an
 * in-flight control-channel request.
 *
 * `before-quit` called `void controlChannelServer.stop()` — the promise
 * explicitly discarded — and then synchronously closed the activity log
 * and the database. `stop()` does synchronously deny every HELD policy
 * check (good, and fail-closed), but the `httpServer.close()` that drains
 * in-flight NON-held requests — a DB-writing tool handler mid-call, say —
 * sits inside that discarded promise.
 *
 * The code's own comment said "revisit once M4 session 2's bureau-hook/
 * bureau-tools are real processes that can actually be mid-request at quit
 * time." They have been real since M4. It was never revisited.
 */
describe('runShutdownSequence (AUDIT #16)', () => {
  it('waits for the control channel to finish draining BEFORE closing the log and the database', async () => {
    const order: string[] = [];
    await runShutdownSequence({
      controlChannelServer: {
        stop: async () => {
          order.push('server.stop:start');
          await new Promise((resolve) => setTimeout(resolve, 25));
          order.push('server.stop:done');
        },
      },
      resumeTick: { stop: () => order.push('resumeTick.stop') },
      checkpointTick: { stop: () => order.push('checkpointTick.stop') },
      messageRouter: { stop: () => order.push('messageRouter.stop') },
      stopLiveState: () => order.push('stopLiveState'),
      chatStreams: { abortAll: () => order.push('chatStreams.abortAll') },
      activityLog: {
        close: () => order.push('activityLog.close'),
        logEvent: (input: { type: string }) => order.push('activityLog.logEvent:' + input.type),
      },
      db: { close: () => order.push('db.close') },
    });

    // Presence before ordering (standing rule 3): indexOf returns -1 for a
    // name that never appeared, and -1 is less than every real index, so an
    // ordering assertion alone passes when the thing simply never ran.
    expect(order).toContain('server.stop:done');
    expect(order).toContain('checkpointTick.stop');
    // M8 session 2's router. Same hazard as the other two timers, plus its
    // own: it is async, so a pass may be mid-`adapter.send()` when the
    // database closes.
    expect(order).toContain('messageRouter.stop');
    expect(order).toContain('activityLog.close');
    expect(order).toContain('db.close');

    // M8's timeout sweep must be stopped before the DB closes under it —
    // a tick firing mid-shutdown would be resolving checkpoints against a
    // closing database.
    expect(order.indexOf('checkpointTick.stop')).toBeLessThan(order.indexOf('db.close'));
    expect(order.indexOf('messageRouter.stop')).toBeLessThan(order.indexOf('db.close'));

    // M9. Both are present (standing rule 3 again) and both are ordered.
    // A stream aborted here writes a real row through the real path, so it
    // has to happen while the database is still open — and while the live
    // broadcast is still running, or the window never sees the final row.
    expect(order).toContain('chatStreams.abortAll');
    expect(order).toContain('stopLiveState');
    expect(order.indexOf('chatStreams.abortAll')).toBeLessThan(order.indexOf('stopLiveState'));
    expect(order.indexOf('chatStreams.abortAll')).toBeLessThan(order.indexOf('db.close'));
    expect(order.indexOf('stopLiveState')).toBeLessThan(order.indexOf('db.close'));
    expect(order.indexOf('server.stop:done')).toBeLessThan(order.indexOf('activityLog.close'));
    expect(order.indexOf('server.stop:done')).toBeLessThan(order.indexOf('db.close'));
    // The log is the mirror's source of truth, so it closes before the DB.
    expect(order.indexOf('activityLog.close')).toBeLessThan(order.indexOf('db.close'));
  });

  it('still closes the log and the database when the server hangs — quit is never blocked forever', async () => {
    const order: string[] = [];
    await runShutdownSequence(
      {
        controlChannelServer: { stop: () => new Promise<void>(() => {}) }, // never resolves
        resumeTick: { stop: () => order.push('resumeTick.stop') },
        checkpointTick: { stop: () => order.push('checkpointTick.stop') },
        messageRouter: { stop: () => order.push('messageRouter.stop') },
        stopLiveState: () => order.push('stopLiveState'),
        chatStreams: { abortAll: () => order.push('chatStreams.abortAll') },
        activityLog: {
          close: () => order.push('activityLog.close'),
          logEvent: (input: { type: string }) => order.push('activityLog.logEvent:' + input.type),
        },
        db: { close: () => order.push('db.close') },
      },
      { drainTimeoutMs: 30 },
    );

    // Fail-safe, not fail-open: a hung request must not strand the user in
    // an app that will not quit. The bounded wait is the compromise, and
    // it is bounded on purpose rather than left to `void`.
    expect(order).toContain('activityLog.close');
    expect(order).toContain('db.close');
  });

  it('still closes the log and the database when the server stop REJECTS', async () => {
    const order: string[] = [];
    await runShutdownSequence({
      controlChannelServer: {
        stop: async () => {
          throw new Error('close failed');
        },
      },
      resumeTick: { stop: () => order.push('resumeTick.stop') },
      checkpointTick: { stop: () => order.push('checkpointTick.stop') },
      messageRouter: { stop: () => order.push('messageRouter.stop') },
      stopLiveState: () => order.push('stopLiveState'),
      chatStreams: { abortAll: () => order.push('chatStreams.abortAll') },
      activityLog: {
        close: () => order.push('activityLog.close'),
        logEvent: (input: { type: string }) => order.push('activityLog.logEvent:' + input.type),
      },
      db: { close: () => order.push('db.close') },
    });

    expect(order).toContain('activityLog.close');
    expect(order).toContain('db.close');
  });

  it('stops the resume tick — no timer survives the shutdown to fire against a closed DB', async () => {
    const order: string[] = [];
    await runShutdownSequence({
      controlChannelServer: { stop: async () => {} },
      resumeTick: { stop: () => order.push('resumeTick.stop') },
      checkpointTick: { stop: () => order.push('checkpointTick.stop') },
      messageRouter: { stop: () => order.push('messageRouter.stop') },
      stopLiveState: () => order.push('stopLiveState'),
      chatStreams: { abortAll: () => order.push('chatStreams.abortAll') },
      activityLog: {
        close: () => order.push('activityLog.close'),
        logEvent: (input: { type: string }) => order.push('activityLog.logEvent:' + input.type),
      },
      db: { close: () => order.push('db.close') },
    });
    expect(order).toContain('resumeTick.stop');
    expect(order.indexOf('resumeTick.stop')).toBeLessThan(order.indexOf('db.close'));
  });
});

/**
 * AUDIT M0–M2 #18. §5.2's `app.stopping` had no emitter, so quitting —
 * unambiguously a state change — left nothing in the timeline.
 *
 * The ordering is the substance, not the presence: it must be written
 * before anything is stopped and long before the log itself closes at the
 * bottom of the sequence. Emitted last, it would be racing the very thing
 * that writes it.
 */
describe('app.stopping (audit #18)', () => {
  const targets = (order: string[]) => ({
    controlChannelServer: { stop: async () => void order.push('server.stop') },
    resumeTick: { stop: () => order.push('resumeTick.stop') },
    checkpointTick: { stop: () => order.push('checkpointTick.stop') },
    messageRouter: { stop: () => order.push('messageRouter.stop') },
    stopLiveState: () => order.push('stopLiveState'),
    chatStreams: { abortAll: () => order.push('chatStreams.abortAll') },
    activityLog: {
      close: () => order.push('activityLog.close'),
      logEvent: (input: { type: string }) => order.push(`activityLog.logEvent:${input.type}`),
    },
    db: { close: () => order.push('db.close') },
  });

  it('records app.stopping before it stops anything, and before the log closes', async () => {
    const order: string[] = [];
    await runShutdownSequence(targets(order));

    // Presence before ordering (standing rule 3).
    expect(order).toContain('activityLog.logEvent:app.stopping');
    expect(order).toContain('activityLog.close');
    expect(order).toContain('resumeTick.stop');

    expect(order[0], 'it is the very first thing the sequence does').toBe(
      'activityLog.logEvent:app.stopping',
    );
    expect(order.indexOf('activityLog.logEvent:app.stopping')).toBeLessThan(
      order.indexOf('activityLog.close'),
    );
  });

  it('still quits when the log refuses the event', async () => {
    // The one place in this codebase where letting `logEvent` throw would
    // be wrong: an app that will not quit because it could not write about
    // quitting strands the user, which is worse than a missing line.
    const order: string[] = [];
    const base = targets(order);
    await expect(
      runShutdownSequence({
        ...base,
        activityLog: {
          close: base.activityLog.close,
          logEvent: () => {
            throw new Error('log is wedged');
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(order).toContain('activityLog.close');
    expect(order).toContain('db.close');
  });
});
