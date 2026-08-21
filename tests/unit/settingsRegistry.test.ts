import { describe, expect, it } from 'vitest';
import {
  SettingsValuesSchema,
  SETTINGS_REGISTRY,
  SETTINGS_KEYS,
} from '../../src/shared/settings/schema';

describe('settings registry (§16.1)', () => {
  it('has exactly the 49 keys the §16.1 table lists', () => {
    expect(SETTINGS_KEYS).toHaveLength(49);
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
