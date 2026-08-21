import { describe, expect, it, beforeEach } from 'vitest';
import { useBureauStore } from '../../../src/renderer/src/store/bureauStore';
import type { StateDelta } from '../../../src/shared/ipc/schemas/events';

/**
 * §17.2's stateDelta semantics, tested as a pure reducer — no Electron,
 * no real IPC round trip, just `applyDelta`'s own logic. The real
 * end-to-end reconnect path (a genuine window reload against the real
 * packaged app) is tests/e2e/stateDeltaReconnect.spec.ts; this is the
 * fast complement that pins down the out-of-order/before-hydration/
 * reconnect-replaces-not-merges behavior precisely, case by case,
 * without paying for a browser launch per case.
 */
describe('bureauStore.applyDelta (§17.2 stateDelta semantics) — unit', () => {
  beforeEach(() => {
    useBureauStore.setState({
      hydrated: false,
      lastAppliedSeq: 0,
      settings: null,
      company: null,
      projects: [],
      tasks: [],
      employees: [],
      checkpoints: [],
    });
  });

  it('a full delta hydrates the store and sets lastAppliedSeq to its own seq', () => {
    const full: StateDelta = {
      kind: 'full',
      seq: 7,
      slices: { settings: { 'general.theme': 'dark' }, company: null, projects: [], tasks: [], employees: [], checkpoints: [] },
    };
    useBureauStore.getState().applyDelta(full);
    const state = useBureauStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.lastAppliedSeq).toBe(7);
    expect(state.settings).toEqual({ 'general.theme': 'dark' });
  });

  it('a patch with seq === lastAppliedSeq + 1 applies and advances the seq', () => {
    useBureauStore.getState().applyDelta({ kind: 'full', seq: 1, slices: { settings: {}, company: null, projects: [], tasks: [], employees: [], checkpoints: [] } });
    useBureauStore.getState().applyDelta({ kind: 'patch', seq: 2, slice: 'company', value: { id: 'c1', name: 'Acme' } });
    const state = useBureauStore.getState();
    expect(state.lastAppliedSeq).toBe(2);
    expect(state.company).toEqual({ id: 'c1', name: 'Acme' });
  });

  it('a patch that arrives with a gap (seq skips ahead) is dropped, not applied', () => {
    useBureauStore.getState().applyDelta({ kind: 'full', seq: 1, slices: { settings: {}, company: null, projects: [], tasks: [], employees: [], checkpoints: [] } });
    useBureauStore.getState().applyDelta({ kind: 'patch', seq: 5, slice: 'company', value: { id: 'c1', name: 'Acme' } });
    const state = useBureauStore.getState();
    expect(state.lastAppliedSeq).toBe(1); // unchanged — the gapped patch never applied
    expect(state.company).toBeNull();
  });

  it('a patch that arrives before any full delta is dropped, not applied', () => {
    useBureauStore.getState().applyDelta({ kind: 'patch', seq: 1, slice: 'company', value: { id: 'c1', name: 'Acme' } });
    const state = useBureauStore.getState();
    expect(state.hydrated).toBe(false);
    expect(state.company).toBeNull();
  });

  it('a second full delta fully replaces state, including resetting lastAppliedSeq backward if needed', () => {
    useBureauStore.getState().applyDelta({ kind: 'full', seq: 10, slices: { settings: {}, company: { id: 'c1', name: 'Old' }, projects: [], tasks: [], employees: [], checkpoints: [] } });
    // A fresh full delta after a reconnect can legitimately have a lower
    // seq than before (the counter is process-lifetime, not per-window) —
    // a full delta is authoritative regardless of the seq relationship.
    useBureauStore.getState().applyDelta({ kind: 'full', seq: 3, slices: { settings: {}, company: null, projects: [], tasks: [], employees: [], checkpoints: [] } });
    const state = useBureauStore.getState();
    expect(state.lastAppliedSeq).toBe(3);
    expect(state.company).toBeNull();
  });

  it('after a dropped gap, the next full delta resumes normal patch application', () => {
    useBureauStore.getState().applyDelta({ kind: 'full', seq: 1, slices: { settings: {}, company: null, projects: [], tasks: [], employees: [], checkpoints: [] } });
    useBureauStore.getState().applyDelta({ kind: 'patch', seq: 9, slice: 'company', value: { id: 'wrong' } }); // dropped
    useBureauStore.getState().applyDelta({ kind: 'full', seq: 2, slices: { settings: {}, company: null, projects: [], tasks: [], employees: [], checkpoints: [] } });
    useBureauStore.getState().applyDelta({ kind: 'patch', seq: 3, slice: 'company', value: { id: 'c1', name: 'Acme' } });
    const state = useBureauStore.getState();
    expect(state.lastAppliedSeq).toBe(3);
    expect(state.company).toEqual({ id: 'c1', name: 'Acme' });
  });
});
