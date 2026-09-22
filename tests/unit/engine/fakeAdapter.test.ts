import { PROBE_LIVENESS_CEILING_MS } from '../../../src/shared/engine/types';
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import type { AgentEvent } from '../../../src/shared/engine/events';
import type { EmployeeContext } from '../../../src/shared/engine/types';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';

function fakeCtx(): EmployeeContext {
  return {
    employee: {} as EmployeeContext['employee'],
    role: {} as EmployeeContext['role'],
    task: null,
    worktreePath: 'C:\\fake\\worktree',
    stateDir: 'C:\\fake\\state',
    baseDir: 'C:\\fake\\state',
    toolServer: placeholderToolServer,
    controlChannel: placeholderControlChannel,
    broker: noopSecretBroker,
    modelId: null,
    turnBudgetCapUsdMicros: null,
  };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('FakeAdapter (§7.8) — the full EngineAdapter contract, scripted', () => {
  it('probe() and capabilities() return sane, internally consistent defaults, overridable by the script', async () => {
    const adapter = new FakeAdapter();
    const probe = await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });
    expect(probe.installed).toBe(true);
    expect(probe.error).toBeNull();

    const caps = adapter.capabilities(probe);
    // §7.8 test 2: permissionCallback ⇒ structuredEvents.
    expect(caps.permissionCallback && !caps.structuredEvents).toBe(false);

    const overridden = new FakeAdapter({ capabilities: { permissionCallback: false } });
    expect(overridden.capabilities(probe).permissionCallback).toBe(false);
  });

  it('buildLaunchSpec never touches ctx.broker (buildLaunchSpec "MUST NOT read secrets directly")', async () => {
    let brokerCalled = false;
    const ctx = fakeCtx();
    ctx.broker = {
      ...noopSecretBroker,
      resolveForSpawn: async (...args) => {
        brokerCalled = true;
        return noopSecretBroker.resolveForSpawn(...args);
      },
    };
    await new FakeAdapter().buildLaunchSpec(ctx);
    expect(brokerCalled).toBe(false);
  });

  it('events() replays the scripted sequence in order, exactly', async () => {
    const script: AgentEvent[] = [
      { t: 'session.started', sessionId: 's1', engineVersion: 'fake', model: null },
      { t: 'turn.started', turnIndex: 0 },
      { t: 'text.delta', text: 'hi' },
      { t: 'idle' },
    ];
    const adapter = new FakeAdapter({ events: script });
    await adapter.start(fakeCtx());
    expect(await drain(adapter.events())).toEqual(script);
  });

  describe('turn-boundary discipline (§7.4, §7.8 test 5)', () => {
    it('send() delivers immediately when idle', async () => {
      const adapter = new FakeAdapter();
      await adapter.start(fakeCtx());
      await adapter.send('go', 'task');
      expect(adapter.sentMessages).toEqual([{ text: 'go', kind: 'task', delivery: 'immediate' }]);
    });

    it('a message sent mid-generation is queued, not delivered, until the next idle event is pulled', async () => {
      const script: AgentEvent[] = [
        { t: 'turn.started', turnIndex: 0 },
        { t: 'text.delta', text: 'working...' },
        { t: 'idle' },
      ];
      const adapter = new FakeAdapter({ events: script });
      await adapter.start(fakeCtx());

      const iterator = adapter.events()[Symbol.asyncIterator]();
      await iterator.next(); // turn.started -> generating
      await iterator.next(); // text.delta -> still generating

      await adapter.send('are you done?', 'message');
      expect(adapter.sentMessages).toEqual([]); // not delivered yet — turnState is 'generating'

      await iterator.next(); // idle -> flush
      expect(adapter.sentMessages).toEqual([
        { text: 'are you done?', kind: 'message', delivery: 'flushed-on-idle' },
      ]);
    });
  });

  describe('applyVerdict + filesystem sentinel (§7.8 test 4: provably did not execute)', () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('a denied verdict never touches the sentinel — the command provably did not execute', async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-fakeadapter-'));
      const sentinelPath = path.join(tmpDir, 'sentinel.txt');
      const adapter = new FakeAdapter({ toolSentinels: { call1: sentinelPath } });

      await adapter.applyVerdict('call1', { effect: 'deny', ruleId: 'r1', reason: 'test' });

      expect(existsSync(sentinelPath)).toBe(false);
      expect(adapter.verdictFor('call1')).toEqual({ effect: 'deny', ruleId: 'r1', reason: 'test' });
    });

    it('an allowed verdict touches the sentinel — proving the check is not a placebo that never fires either way', async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-fakeadapter-'));
      const sentinelPath = path.join(tmpDir, 'sentinel.txt');
      const adapter = new FakeAdapter({ toolSentinels: { call1: sentinelPath } });

      await adapter.applyVerdict('call1', { effect: 'allow', ruleId: 'r1' });

      expect(existsSync(sentinelPath)).toBe(true);
    });

    it('a callId with no configured sentinel is a harmless no-op either way', async () => {
      const adapter = new FakeAdapter();
      await expect(
        adapter.applyVerdict('unscripted', { effect: 'allow', ruleId: 'r1' }),
      ).resolves.toBeUndefined();
    });
  });

  it('a scripted event can carry an arbitrary payload unchanged — e.g. a canary value a §7.8 test 9-style scanner would check for (M6 owns the real redactor; this just proves FakeAdapter does not alter payloads)', async () => {
    const canary = 'sk-canary-CHANGEME-0001';
    const script: AgentEvent[] = [
      {
        t: 'tool.requested',
        callId: 'c1',
        tool: 'Bash',
        rawTool: 'Bash',
        args: {},
        preview: `echo ${canary}`,
      },
    ];
    const adapter = new FakeAdapter({ events: script });
    const [event] = await drain(adapter.events());
    expect(event).toEqual(script[0]);
    if (event?.t === 'tool.requested') {
      expect(event.preview).toContain(canary);
    }
  });

  it('interrupt() resolves promptly and never hangs', async () => {
    const adapter = new FakeAdapter();
    await adapter.interrupt();
    expect(adapter.interruptCallCount).toBe(1);
  });

  it('stop() records that it was called, with the grace period given', async () => {
    const adapter = new FakeAdapter();
    expect(adapter.wasStopped).toBe(false);
    await adapter.stop(5000);
    expect(adapter.wasStopped).toBe(true);
    expect(adapter.lastStopGraceMs).toBe(5000);
  });

  describe('resume() — §7.1: "false if unsupported or gone. MUST NOT hang."', () => {
    it('returns true for a scripted resumable session', async () => {
      const adapter = new FakeAdapter({ resumeResults: { s1: true } });
      await expect(adapter.resume('s1', fakeCtx())).resolves.toBe(true);
    });

    it('returns false, not a hang, for an unscripted/unknown session', async () => {
      const adapter = new FakeAdapter();
      await expect(adapter.resume('does-not-exist', fakeCtx())).resolves.toBe(false);
    });
  });
});
