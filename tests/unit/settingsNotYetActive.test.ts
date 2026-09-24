import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SETTINGS_REGISTRY, type SettingKey } from '../../src/shared/settings/schema';
import { SettingField } from '../../src/renderer/src/components/SettingsPanel';

/**
 * S-5: a registered setting nothing reads must not look as if it works. The
 * registry records which milestone makes it active (`inactiveUntil`), and the
 * Settings panel labels it and disables its input.
 *
 * The marker is kept honest in BOTH directions by scanning \`src/\`: a key with
 * no reader outside the schema must carry it, and a key that carries it must
 * still have no reader (so wiring a setting forces removing the label).
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

const SCHEMA = path.resolve('src/shared/settings/schema.ts');
const sources = sourceFiles(path.resolve('src'))
  .filter((file) => path.resolve(file) !== SCHEMA)
  .map((file) => readFileSync(file, 'utf8'));
const hasReader = (key: string): boolean => sources.some((text) => text.includes(`'${key}'`));

describe('S-5: settings nothing reads are marked and not presented as working', () => {
  const keys = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

  it.each(keys)('%s: marked inactive exactly when nothing in src/ reads it', (key) => {
    const meta = SETTINGS_REGISTRY[key];
    expect(meta.inactiveUntil !== undefined, `${key}: marker and readers disagree`).toBe(
      !hasReader(key),
    );
  });

  it('the Settings panel labels an inactive setting and disables its input', () => {
    const html = renderToStaticMarkup(
      createElement(SettingField, { settingKey: 'orchestrator.maxConcurrentEmployees', value: 3 }),
    );
    expect(html).toContain('Not in use yet');
    expect(html).toMatch(/<input[^>]*disabled/);
  });

  it('an active setting is neither labelled nor disabled', () => {
    const html = renderToStaticMarkup(
      createElement(SettingField, { settingKey: 'budgets.dailyUsd', value: 20 }),
    );
    expect(html).not.toContain('Not in use yet');
    expect(html).not.toMatch(/<input[^>]*disabled/);
  });
});
