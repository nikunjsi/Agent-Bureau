// AUDIT M0–M2 #24 — §16.1's settings table against the registry.
//
// §16.1 says "Adding a setting means adding it here (both the value schema
// and the SETTINGS_REGISTRY metadata) in the same commit" — and until this
// script nothing enforced it. settingsRegistry.test.ts pins a key COUNT,
// which caught M9's missing review.trivialTaskMaxChangedLines and fix 3a's
// general.floorPaneWidth, but a count cannot see a renamed key, a wrong
// group, or a scope that disagrees with the prose.
//
// Checked per key: present in all three of §16.1 / SettingsValuesSchema /
// SETTINGS_REGISTRY; the group matches; the "per employee/project/role/
// engine" scope prose matches overridableBy; and the default matches for
// every key whose default is not computed at first run.
import { importTs, report, specSection } from './specLists.mjs';

const ROW = /^\|\s*`([a-zA-Z0-9._]+)`\s*\|(.*)\|(.*)\|(.*)\|(.*)\|\s*$/;
const SCOPES = ['employee', 'project', 'role', 'engine'];

const rows = [];
for (const line of specSection('### 16.1 Settings registry', '## 17.')) {
  const m = ROW.exec(line);
  if (m) {
    rows.push({ key: m[1], def: m[3].trim(), scope: m[4].trim(), group: m[5].trim() });
  }
}

const { SettingsValuesSchema, SETTINGS_REGISTRY } = await importTs('src/shared/settings/schema.ts');
const schemaKeys = new Set(Object.keys(SettingsValuesSchema.shape));
const registryKeys = new Set(Object.keys(SETTINGS_REGISTRY));
const specKeys = new Set(rows.map((r) => r.key));
const problems = [];

if (rows.length === 0) problems.push('  found no §16.1 rows at all — the parser is broken');

for (const key of [...new Set([...specKeys, ...schemaKeys, ...registryKeys])].sort()) {
  const missing = [];
  if (!specKeys.has(key)) missing.push('§16.1');
  if (!schemaKeys.has(key)) missing.push('SettingsValuesSchema');
  if (!registryKeys.has(key)) missing.push('SETTINGS_REGISTRY');
  if (missing.length > 0) problems.push(`  ${key}: missing from ${missing.join(' and ')}`);
}

const defaults = SettingsValuesSchema.parse({});
const normalise = (value) =>
  String(value)
    .replace(/[`_,]/g, '')
    .replace(/\s*\(.*\)/, '')
    .trim();

for (const row of rows) {
  const meta = SETTINGS_REGISTRY[row.key];
  if (meta === undefined) continue;

  if (meta.group !== row.group) {
    problems.push(
      `  ${row.key}: group is "${row.group}" in §16.1 and "${meta.group}" in the registry`,
    );
  }

  const expected = SCOPES.filter((s) => new RegExp(`per ${s}`).test(row.scope)).sort();
  const actual = [...(meta.overridableBy ?? [])].sort();
  if (expected.join(',') !== actual.join(',')) {
    problems.push(
      `  ${row.key}: scope "${row.scope}" implies [${expected}], registry overridableBy is [${actual}]`,
    );
  }

  if (!meta.dynamicDefault) {
    const specDefault = normalise(row.def);
    const value = defaults[row.key];
    const codeDefault = normalise(typeof value === 'object' ? JSON.stringify(value) : value);
    // decimal→micros settings: §16.1 writes 20.00, the schema yields 20000000.
    const asMicros = Number(specDefault);
    const moneyMatches =
      Number.isFinite(asMicros) && Math.round(asMicros * 1e6) === Number(codeDefault);
    if (specDefault !== codeDefault && !moneyMatches) {
      problems.push(
        `  ${row.key}: default is "${row.def}" in §16.1 and ${JSON.stringify(value)} in the schema`,
      );
    }
  }
}

report(
  'check:settings-spec',
  problems,
  `§16.1 matches the settings registry: ${rows.length} keys, groups, scopes and defaults.`,
);
