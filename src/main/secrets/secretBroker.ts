import type Database from 'better-sqlite3';
import type { SecretBroker, SpawnSecrets } from '../../shared/engine/seams';
import { retrieveSecret, type SafeStorageLike } from './secretStore';
import { globalSecretRegistry, type SecretRegistry } from './redactor';

const ANTHROPIC_API_KEY_SETTING = 'anthropic_api_key';

/**
 * §11.4/§7.6 — the real `SecretBroker`, replacing `noopSecretBroker`.
 * `resolveForSpawn`: only `claude-code` is a real engine today. The real,
 * CURRENT default (§7.6's own M3 decision, unchanged by this session) is
 * that no key is injected at all — employees inherit whatever
 * subscription auth their per-employee `CLAUDE_CONFIG_DIR` resolves to,
 * since a present `ANTHROPIC_API_KEY` always wins over subscription auth
 * in headless mode, which would silently move usage onto metered
 * billing. Only when a user has EXPLICITLY stored a key (a deliberate
 * opt-in into metered billing) does this inject one — and the moment it
 * does, that value is registered into the shared `SecretRegistry` so it
 * becomes redactable everywhere, not just for the employee whose spawn
 * happened to resolve it first.
 */
export function createRealSecretBroker(
  db: Database.Database,
  registry: SecretRegistry = globalSecretRegistry,
  // Injectable for tests, same reason secretStore.ts's own functions take
  // one — plain-Node test runs have no live `electron` module to import.
  safeStorage?: SafeStorageLike | (() => Promise<SafeStorageLike>),
): SecretBroker {
  return {
    async resolveForSpawn({ engineKey }): Promise<SpawnSecrets> {
      if (engineKey !== 'claude-code') return { env: {}, secretValues: [] };

      const apiKey = safeStorage
        ? await retrieveSecret(db, ANTHROPIC_API_KEY_SETTING, safeStorage)
        : await retrieveSecret(db, ANTHROPIC_API_KEY_SETTING);
      if (apiKey === null) return { env: {}, secretValues: [] };

      registry.register([apiKey]);
      return { env: { ANTHROPIC_API_KEY: apiKey }, secretValues: [apiKey] };
    },

    /**
     * A real, honest no-op for this implementation — not a placeholder
     * left unfinished. §11.4 itself: "model provider API keys are
     * long-lived and cannot be scoped down or minted short-lived — no
     * provider offers that." A single, shared, long-lived key (the only
     * kind any real engine offers today) has nothing per-employee to
     * revoke; revoking it would mean deleting the user's own stored key
     * out from under every OTHER employee too, which is not what "this
     * employee stopped" means. The interface stays real (not removed)
     * for a future broker backing a provider that genuinely offers
     * scoped, per-session credentials — this call site is exactly where
     * that implementation would do real work. Still called on every real
     * exit path that exists (`Supervisor.stop()`, `reconcile.ts`'s orphan
     * sweep) per its own interface contract, even though there is
     * nothing to do with it yet.
     */
    async revokeForEmployee(): Promise<void> {
      // Intentional no-op — see doc comment above.
    },
  };
}

export { ANTHROPIC_API_KEY_SETTING };
