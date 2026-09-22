import type Database from 'better-sqlite3';
import { nowIso } from '../../shared/models/ids';
import { getSecretsMeta, upsertSecretsMeta } from '../db/repositories/secretsMeta';

/** The exact shape of the one Electron API this module needs — injectable
 * so tests never need a live Electron `app`. The real implementation is
 * `electron`'s own `safeStorage`, obtained via the same lazy dynamic
 * `import('electron')` pattern `toolClassify.ts`/`zeroCostMode.ts`
 * already established (a top-level import here would drag `electron`
 * into any plain-Node bundle that merely imports this file). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

async function realSafeStorage(): Promise<SafeStorageLike> {
  const { safeStorage } = await import('electron');
  return safeStorage;
}

/**
 * §11.4, verbatim: "safeStorage on Windows IS DPAPI. There is no separate
 * keychain to fall back to" — so there is exactly one storage backend
 * here, not a chain of them, and no dead fallback branch pretending
 * otherwise. `isEncryptionAvailable()` is only ever meaningful after
 * `app.whenReady()` has resolved (documented in `safeStorage`'s own
 * Electron docs) — this module never calls it eagerly at import time;
 * every real caller is itself only reachable from inside the main
 * process's own post-`whenReady` flow (IPC handlers, `Supervisor`).
 */
export interface StoreSecretResult {
  readonly stored: boolean;
  /** Set only when `stored` is false — why Bureau refused. */
  readonly reason?: string;
}

/**
 * Refuses to store plaintext rather than writing it — §11.4's own literal
 * rule: "If `isEncryptionAvailable()` returns false, Bureau REFUSES to
 * store the key and asks each session rather than writing plaintext."
 * Never writes to `settings.json`, never an env file, never argv — the
 * only two things this ever touches are `safeStorage`'s own OS-level
 * encryption and `secrets_meta`'s metadata row. The ciphertext itself is
 * stored base64-encoded directly in `secrets_meta.storage_ref` — simpler
 * and more robust than a separate file (one atomic DB write, no
 * file/DB-desync window to reconcile on crash) — `storage_ref`'s own
 * column comment ("no values, ever") still holds: what's stored there is
 * ciphertext, unreadable without the same machine's own DPAPI key, never
 * a value in the §11.4 sense.
 */
export async function storeSecret(
  db: Database.Database,
  key: string,
  plainText: string,
  provider: string | null,
  safeStorage: SafeStorageLike | (() => Promise<SafeStorageLike>) = realSafeStorage,
): Promise<StoreSecretResult> {
  const resolved = typeof safeStorage === 'function' ? await safeStorage() : safeStorage;
  if (!resolved.isEncryptionAvailable()) {
    return {
      stored: false,
      reason:
        'This machine has no available OS-level encryption (Windows DPAPI) for Bureau to use — refusing to store the key in plaintext. You will be asked for it again next session.',
    };
  }
  const ciphertext = resolved.encryptString(plainText).toString('base64');
  upsertSecretsMeta(db, {
    key,
    provider,
    storage_ref: ciphertext,
    last_set_at: nowIso(),
    last_used_at: null,
  });
  return { stored: true };
}

/** `null` when nothing is stored for `key` — the real, current default
 * for every secret this session has any real caller for (§7.6: claude-code
 * employees inherit subscription auth via `CLAUDE_CONFIG_DIR` unless a
 * user has explicitly stored an API key). Updates `last_used_at` on every
 * successful decrypt, real bookkeeping a future settings screen can show
 * ("last used 2 minutes ago"), not decorative. */
export async function retrieveSecret(
  db: Database.Database,
  key: string,
  safeStorage: SafeStorageLike | (() => Promise<SafeStorageLike>) = realSafeStorage,
): Promise<string | null> {
  const meta = getSecretsMeta(db, key);
  if (!meta || meta.storage_ref === null) return null;
  const resolved = typeof safeStorage === 'function' ? await safeStorage() : safeStorage;
  if (!resolved.isEncryptionAvailable()) return null; // can't decrypt what we can't encrypt
  const plainText = resolved.decryptString(Buffer.from(meta.storage_ref, 'base64'));
  upsertSecretsMeta(db, {
    key,
    provider: meta.provider,
    storage_ref: meta.storage_ref,
    last_set_at: meta.last_set_at,
    last_used_at: nowIso(),
  });
  return plainText;
}

/** Clears a stored secret — real deletion, not a soft flag: the next
 * `retrieveSecret` call for this key returns `null`, matching "never
 * displayed again, only set/replace/clear" (§11.4). */
export function clearSecret(db: Database.Database, key: string): void {
  upsertSecretsMeta(db, {
    key,
    provider: null,
    storage_ref: null,
    last_set_at: null,
    last_used_at: null,
  });
}

/**
 * §11.4's own honest note, verbatim, exported as a real constant so the
 * (M9/M13) settings UI renders the exact string Bureau ships rather than
 * re-deriving its own paraphrase — the seam this session owns even though
 * the screen that displays it does not.
 */
export const API_KEY_HONEST_NOTE =
  'Model provider API keys are long-lived and cannot be scoped down or minted short-lived — no provider offers that today. ' +
  'Bureau limits the blast radius (an otherwise-empty process environment, a process-scoped lifetime, and redaction everywhere ' +
  'the key could otherwise appear) but the employee process genuinely holds a usable key. If you want stronger separation, ' +
  'provision a separate, low-limit key for Bureau rather than reusing your primary one.';
