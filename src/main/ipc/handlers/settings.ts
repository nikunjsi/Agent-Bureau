import path from 'node:path';
import {
  HOOK_TIMEOUT_MARGIN_MINUTES,
  HookTimingInvalidError,
  validateHookTiming,
} from '../../controlChannel/hookTiming';
import { writeSettingsSnapshot } from '../../settings/settingsSnapshot';
import { getAllSettings, getSetting, setSetting } from '../../db/repositories/settings';
import { getSecretsMeta } from '../../db/repositories/secretsMeta';
import type { SettingKey, SettingsValues } from '../../../shared/settings/schema';
import { ipcOk, ipcError } from '../../../shared/ipc/envelope';
import {
  Settings as SettingsSchemas,
  STORABLE_SECRET_KEYS,
  type StorableSecretKey,
} from '../../../shared/ipc/schemas/settings';
import { canEnableZeroCostMode } from '../../cost/zeroCostMode';
import {
  API_KEY_HONEST_NOTE,
  clearSecret as clearStoredSecret,
  storeSecret,
} from '../../secrets/secretStore';
import type { Handler, HandlerContext } from './types';

function listAllSecretsStatus(ctx: HandlerContext) {
  // §11.4/settings.ts: only ever metadata (provider, when set) — never a
  // value. Every key Settings can store, and only one that is stored: a
  // cleared key keeps its row with nothing in it, which is not "stored".
  return STORABLE_SECRET_KEYS.map((key) => getSecretsMeta(ctx.db, key))
    .filter((m) => m !== null && m.storage_ref !== null)
    .map((m) => ({ key: m!.key, provider: m!.provider, lastSetAt: m!.last_set_at }));
}

/** Which provider a stored key belongs to, for the status line. */
function providerFor(ctx: HandlerContext, key: StorableSecretKey): string | null {
  if (key === 'anthropic_api_key') return 'anthropic';
  return getSetting(ctx.db, 'engines.oneshotProvider') || null;
}

/** One event per stored or cleared key (invariant #3) — the key's name only, never its value. */
function logSecretChanged(ctx: HandlerContext, key: StorableSecretKey): void {
  ctx.activityLog.logEvent({
    actor: 'user',
    type: 'app.setting_changed',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: { key },
  });
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

    // S-1 / §7.10: the hook timing keys are validated as a pair before either
    // is written. Startup refuses to run with an invalid pair, so letting one
    // through here would leave the user unable to open Settings to fix it.
    if (
      settingKey === 'permissions.maxHoldMinutes' ||
      settingKey === 'permissions.hookSelfDeadlineMs'
    ) {
      const maxHoldMinutes =
        settingKey === 'permissions.maxHoldMinutes'
          ? (value as number)
          : getSetting(ctx.db, 'permissions.maxHoldMinutes');
      try {
        validateHookTiming({
          maxHoldMinutes,
          hookSelfDeadlineMs:
            settingKey === 'permissions.hookSelfDeadlineMs'
              ? (value as number)
              : getSetting(ctx.db, 'permissions.hookSelfDeadlineMs'),
          registeredHookTimeoutSeconds: (maxHoldMinutes + HOOK_TIMEOUT_MARGIN_MINUTES) * 60,
        });
      } catch (err) {
        if (err instanceof HookTimingInvalidError) {
          return ipcError('VALIDATION_FAILED', err.message);
        }
        throw err;
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
    // AUDIT M0–M2 #26: §16.1's inspection copy. The setting is already
    // committed and logged, so a failure here must not report the change as
    // failed — it is a convenience copy, and the authoritative value is in
    // the database either way.
    try {
      writeSettingsSnapshot(ctx.db, path.dirname(ctx.dbPaths.dbPath));
    } catch (err) {
      console.error('[settings] could not write settings.json:', err);
    }
    return ipcOk({ ok: true as const });
  },
  getSecretsStatus: (_input, ctx) =>
    ipcOk({ items: listAllSecretsStatus(ctx), note: API_KEY_HONEST_NOTE }),
  // M11 S1-5: these were stub('M13') while pre-M11 X-20 shipped a Settings
  // field that called them, so no key could be saved through the app. E-4
  // makes the Anthropic API key Bureau's primary sign-in, so storing it is
  // M11's. §11.4: DPAPI through safeStorage, write-only over IPC, and never
  // plaintext — a machine without OS encryption is refused with the store's
  // own plain reason.
  setSecret: async (input, ctx) => {
    const { key, value } = SettingsSchemas.setSecret.input.parse(input);
    const result = await storeSecret(ctx.db, key, value, providerFor(ctx, key), ctx.safeStorage);
    if (!result.stored) {
      return ipcError('VALIDATION_FAILED', result.reason ?? 'Bureau could not store that key.');
    }
    logSecretChanged(ctx, key);
    return ipcOk({ ok: true as const });
  },
  clearSecret: (input, ctx) => {
    const { key } = SettingsSchemas.clearSecret.input.parse(input);
    clearStoredSecret(ctx.db, key);
    logSecretChanged(ctx, key);
    return ipcOk({ ok: true as const });
  },
};
