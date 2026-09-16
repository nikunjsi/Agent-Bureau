import { describe, expect, it } from 'vitest';
import {
  SettingsValuesSchema,
  SETTINGS_REGISTRY,
  SETTINGS_KEYS,
} from '../../src/shared/settings/schema';

describe('settings registry (§16.1)', () => {
  it('has exactly the 52 keys the §16.1 table lists', () => {
    // 50, not 49: M4 session 2 added permissions.hookSelfDeadlineMs
    // (§7.10 item 3) — updated in the same commit as the §16.1 table.
    //
    // 51, not 50: M9 added review.trivialTaskMaxChangedLines (AUDIT #28).
    // §16.1 has listed it since the spec was written; the schema and the
    // registry never had it, so `review.autoAcceptTrivialTasks` had no
    // threshold to read. This count is the guard that noticed — it failed
    // the moment the key landed, which is the whole reason it is a number
    // rather than a shrug.
    //
    // 52, not 51: the M0–M2 re-audit's #17 added general.floorPaneWidth —
    // §14.1's "Splitter is draggable and persisted", which had no key to
    // persist into. It fired again, on cue. At the time it was the only
    // thing standing in for a spec↔registry check; fix 3b (audit #24)
    // added the real one, `scripts/checkSettingsSpec.mjs`, which compares
    // keys, groups, scopes and defaults rather than a count.
    expect(SETTINGS_KEYS).toHaveLength(52);
  });

  it('every registry key has a matching schema key, and vice versa', () => {
    const schemaKeys = Object.keys(SettingsValuesSchema.shape).sort();
    const registryKeys = [...SETTINGS_KEYS].sort();
    expect(schemaKeys).toEqual(registryKeys);
  });

  it('parsing an empty object yields every documented default', () => {
    const defaults = SettingsValuesSchema.parse({});
    expect(defaults['general.theme']).toBe('system');
    expect(defaults['general.notifications']).toBe(true);
    expect(defaults['autonomy.default']).toBe('guided');
    expect(defaults['budgets.onExceed']).toBe('park');
    expect(defaults['floor.scale']).toBe(2);
    expect(defaults['updates.channel']).toBe('stable');
    // AUDIT M0–M2 #17. 256 is the `w-64` the floor pane was hardcoded to
    // before it could be dragged, so an existing window does not jump on
    // upgrade.
    expect(defaults['general.floorPaneWidth']).toBe(256);
  });

  /**
   * AUDIT M0–M2 #17 — the splitter width is the first setting a user
   * writes by *gesture* rather than by typing, which makes an out-of-range
   * value much easier to produce: a drag on a 4K monitor, or a hand-edited
   * `settings` row. §16.1 documents the range, so the schema enforces it
   * rather than trusting the renderer's own clamp — the renderer clamps
   * too, and neither is the only line of defence.
   */
  it('the floor pane width is bounded, so a pane cannot cover the chat', () => {
    expect(() => SettingsValuesSchema.parse({ 'general.floorPaneWidth': 4000 })).toThrow();
    expect(() => SettingsValuesSchema.parse({ 'general.floorPaneWidth': 0 })).toThrow();
    expect(() => SettingsValuesSchema.parse({ 'general.floorPaneWidth': 300.5 })).toThrow();
    expect(
      SettingsValuesSchema.parse({ 'general.floorPaneWidth': 320 })['general.floorPaneWidth'],
    ).toBe(320);
  });

  it('decimal→micros settings are already converted to integer micros by the schema', () => {
    const defaults = SettingsValuesSchema.parse({});
    expect(defaults['budgets.dailyUsd']).toBe(20_000_000);
    expect(defaults['budgets.projectUsd']).toBe(50_000_000);
    expect(defaults['budgets.perTaskUsd']).toBe(2_000_000);
    expect(defaults['budgets.perEmployeeDailyUsd']).toBe(8_000_000);
    expect(defaults['budgets.directorReserveUsd']).toBe(2_000_000);
  });

  it('the four dynamic-default keys are marked as such in the registry', () => {
    expect(SETTINGS_REGISTRY['general.homeFolder'].dynamicDefault).toBe(true);
    expect(SETTINGS_REGISTRY['engines.default'].dynamicDefault).toBe(true);
    expect(SETTINGS_REGISTRY['engines.modelTiers'].dynamicDefault).toBe(true);
    expect(SETTINGS_REGISTRY['engines.oneshotProvider'].dynamicDefault).toBe(true);
  });

  it('overridable-scope settings match §16.1s prose exactly', () => {
    expect(SETTINGS_REGISTRY['autonomy.default'].overridableBy).toEqual(['employee']);
    expect(SETTINGS_REGISTRY['budgets.projectUsd'].overridableBy).toEqual(['project']);
    expect(SETTINGS_REGISTRY['budgets.perTaskUsd'].overridableBy).toEqual(['role']);
    expect(SETTINGS_REGISTRY['budgets.perEmployeeDailyUsd'].overridableBy).toEqual(['employee']);
    expect(SETTINGS_REGISTRY['orchestrator.stallTimeoutS'].overridableBy).toEqual(['role']);
    expect(SETTINGS_REGISTRY['orchestrator.maxReassignments'].overridableBy).toEqual(['role']);
    expect(SETTINGS_REGISTRY['pty.readyDebounceMs'].overridableBy).toEqual(['engine']);
    expect(SETTINGS_REGISTRY['memory.defaultBudgetTokens'].overridableBy).toEqual(['role']);
  });

  it('rejects an invalid value for an enum-typed setting', () => {
    expect(() => SettingsValuesSchema.parse({ 'general.theme': 'purple' })).toThrow();
  });

  it('rejects an out-of-union value for floor.scale', () => {
    expect(() => SettingsValuesSchema.parse({ 'floor.scale': 4 })).toThrow();
  });
});
