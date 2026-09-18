import { useState } from 'react';
import { useBureauStore } from '../store/bureauStore';
import { SETTINGS_REGISTRY, type SettingKey } from '../../../shared/settings/schema';
import { ErrorNotice, type NoticeError } from './ErrorNotice';
import { HelperKeyField } from './HelperKeyField';

/**
 * A generic, registry-driven editor — every key from `SETTINGS_REGISTRY`
 * grouped and editable, wired to the real `settings.get`/`set`. Not the
 * curated per-group experience §16 describes in full (Prerequisites'
 * re-check button, Engine connection flows, the Costs dashboard) — those
 * need backends that arrive with M3/M6/M13; this satisfies "Settings is
 * one of the surfaces" M2 needs to validate without building ahead of
 * those milestones.
 */
const GROUP_ORDER = [
  'General',
  'Engines',
  'Autonomy',
  'Budgets',
  'Memory',
  'Privacy',
  'Advanced',
  'About',
] as const;

function keysByGroup(): Map<string, SettingKey[]> {
  const map = new Map<string, SettingKey[]>();
  for (const [key, meta] of Object.entries(SETTINGS_REGISTRY) as [
    SettingKey,
    { group: string },
  ][]) {
    const list = map.get(meta.group) ?? [];
    list.push(key);
    map.set(meta.group, list);
  }
  return map;
}

export function SettingField({
  settingKey,
  value,
}: {
  settingKey: SettingKey;
  value: unknown;
}): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  // S-5: a setting nothing reads yet is labelled and cannot be edited, so it
  // is never mistaken for one that changes something.
  const inactive = SETTINGS_REGISTRY[settingKey].inactiveUntil !== undefined;
  const [error, setError] = useState<NoticeError | null>(null);

  async function save(newValue: unknown): Promise<void> {
    setSaving(true);
    setError(null);
    const result = await window.bureau.settings.set({ key: settingKey, value: newValue });
    setSaving(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <label htmlFor={settingKey} className="text-sm text-bureau-text">
        {settingKey}
        {inactive && <span className="ml-2 text-xs text-bureau-text-muted">Not in use yet</span>}
      </label>
      <div className="flex items-center gap-2">
        {typeof value === 'boolean' ? (
          <input
            id={settingKey}
            type="checkbox"
            defaultChecked={value}
            disabled={saving || inactive}
            onChange={(e) => void save(e.target.checked)}
          />
        ) : typeof value === 'number' ? (
          <input
            id={settingKey}
            type="number"
            defaultValue={value}
            disabled={saving || inactive}
            className="w-28 rounded border border-bureau-border bg-bureau-bg px-1.5 py-0.5 text-sm"
            onBlur={(e) => void save(Number(e.target.value))}
          />
        ) : typeof value === 'string' ? (
          <input
            id={settingKey}
            type="text"
            defaultValue={value}
            disabled={saving || inactive}
            className="w-40 rounded border border-bureau-border bg-bureau-bg px-1.5 py-0.5 text-sm"
            onBlur={(e) => void save(e.target.value)}
          />
        ) : (
          <span className="font-mono text-xs text-bureau-text-muted">{JSON.stringify(value)}</span>
        )}
        {error !== null && <ErrorNotice error={error} className="text-xs" />}
      </div>
    </div>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useBureauStore((state) => state.settings);
  const grouped = keysByGroup();

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40">
      <div
        role="dialog"
        aria-label="Settings"
        className="flex max-h-[80vh] w-[36rem] flex-col overflow-hidden rounded border border-bureau-border bg-bureau-bg shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-bureau-border px-4 py-2">
          <h2 className="font-medium text-bureau-text">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="rounded px-2 hover:bg-bureau-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            ✕
          </button>
        </div>
        <div className="overflow-auto px-4 py-2">
          {settings === null ? (
            <p className="py-8 text-center text-sm text-bureau-text-muted">Loading…</p>
          ) : (
            GROUP_ORDER.filter((group) => grouped.has(group)).map((group) => (
              <section key={group} className="border-b border-bureau-border py-2 last:border-b-0">
                <h3 className="mb-1 text-xs font-semibold uppercase text-bureau-text-muted">
                  {group}
                </h3>
                {(grouped.get(group) ?? []).map((key) => (
                  <SettingField key={key} settingKey={key} value={settings[key]} />
                ))}
                {/* §22.4's helper-key entry lives with the engines, because that
                    is what it configures — the one-shot provider (X-20). */}
                {group === 'Engines' && <HelperKeyField />}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
