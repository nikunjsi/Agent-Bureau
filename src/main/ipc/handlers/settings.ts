import { getAllSettings, getSetting, setSetting } from '../../db/repositories/settings';
import { getSecretsMeta } from '../../db/repositories/secretsMeta';
import type { SettingKey, SettingsValues } from '../../../shared/settings/schema';
import { ipcOk, ipcError } from '../../../shared/ipc/envelope';
import { Settings as SettingsSchemas } from '../../../shared/ipc/schemas/settings';
import { canEnableZeroCostMode } from '../../cost/zeroCostMode';
import { stub, type Handler, type HandlerContext } from './types';

function listAllSecretsStatus(ctx: HandlerContext) {
  // §11.4/settings.ts: only ever metadata (provider, when set) — never a
  // value. secrets_meta rows are upserted by whatever connects an engine
  // (M13); today this is very likely empty, and that's the honest state.
  const keys = ['anthropic_api_key'] as const; // the one secret kind that can exist before M13's real registry
  return keys
    .map((key) => getSecretsMeta(ctx.db, key))
    .filter((m) => m !== null)
    .map((m) => ({ key: m.key, provider: m.provider, lastSetAt: m.last_set_at }));
}

export const settingsHandlers: Record<string, Handler> = {
  get: (_input, ctx) => ipcOk({ item: getAllSettings(ctx.db) }),
  set: async (input, ctx) => {
    const { key, value } = SettingsSchemas.set.input.parse(input);
    const settingKey = key as SettingKey;

    // §24.5: "Bureau refuses to enable the setting and explains why" — the
    // one key whose value this handler cannot just pass through blind.
    // Checked only on the transition INTO zero-cost mode (turning it off
    // is always safe), against the engine actually configured today.
    if (settingKey === 'costs.zeroCostMode' && value === true) {
      const engine = getSetting(ctx.db, 'engines.default');
      const check = await canEnableZeroCostMode(engine || 'claude-code');
      if (!check.allowed) {
        return ipcError('VALIDATION_FAILED', `Can't enable zero-cost mode: ${check.reason}`);
      }
    }

    setSetting(ctx.db, settingKey, value as SettingsValues[SettingKey]);
    // CLAUDE.md invariant #3: every state change is committed before the
    // side effect and emits exactly one activity event — setSetting()
    // above already committed; this is the "emits exactly one" half.
    ctx.activityLog.logEvent({
      actor: 'user',
      type: 'app.setting_changed',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { key: settingKey },
    });
    return ipcOk({ ok: true as const });
  },
  getSecretsStatus: (_input, ctx) => ipcOk({ items: listAllSecretsStatus(ctx) }),
  // Writing/clearing a secret value needs Electron's safeStorage wired up
  // deliberately (which milestone owns that isn't settled yet) — not
  // something to bolt on as a side effect of the settings transport.
  setSecret: stub('M13'),
  clearSecret: stub('M13'),
};
