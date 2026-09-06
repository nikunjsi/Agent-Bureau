/**
 * Sprite keys and variants.
 *
 * `KNOWN_SPRITE_KEYS` lived inside `src/main/packs/validatePack.ts` until
 * M7 session 2, when hiring became its second consumer (§6.8: "pick a
 * sprite variant"). A constant two modules depend on does not belong
 * inside one of them — and `src/shared/floor/` is where §13.4 already
 * places `deriveVisualState.ts`, so this is the directory the floor's
 * shared vocabulary lives in.
 */

/**
 * §6.7 check 7. The REAL check — that a key resolves in a loaded texture
 * atlas — cannot exist until M12 builds the atlas; there is no sprite
 * manifest in the repo to read. This is the set the shipped packs use, and
 * an unknown key is a WARNING with a documented fallback, exactly as §6.7
 * specifies. Stated as a seam rather than dressed up as the atlas check it
 * is not.
 */
export const KNOWN_SPRITE_KEYS: readonly string[] = [
  'director',
  'architect',
  'dev',
  'tester',
  'reviewer',
  'devops',
  'analyst',
  'writer',
  'generic',
];

export const FALLBACK_SPRITE_KEY = 'generic';

/** How many colour/appearance variants each sheet is assumed to carry.
 * M12 owns the real atlas; this is the number the shipped art targets. */
export const SPRITE_VARIANTS_PER_KEY = 4;

export function resolveSpriteKey(requested: string): string {
  return KNOWN_SPRITE_KEYS.includes(requested) ? requested : FALLBACK_SPRITE_KEY;
}

/**
 * A stable variant for one employee.
 *
 * Seeded by the EMPLOYEE ID rather than by hire order or a counter, so a
 * person keeps their appearance across restarts, across a re-pack, and
 * across being fired and rehired — the id is the one thing about them that
 * never changes. A counter would renumber everyone the moment somebody
 * left.
 *
 * The hash is FNV-1a: tiny, dependency-free, and deterministic across
 * platforms, which matters because the layout it feeds is asserted
 * byte-identical.
 */
export function spriteVariantFor(employeeId: string, spriteKey: string): string {
  const key = resolveSpriteKey(spriteKey);
  let hash = 0x811c9dc5;
  for (let i = 0; i < employeeId.length; i += 1) {
    hash ^= employeeId.charCodeAt(i);
    // >>> 0 keeps this in unsigned 32-bit space; Math.imul is the
    // standard way to get a real 32-bit multiply in JS.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${key}_${hash % SPRITE_VARIANTS_PER_KEY}`;
}
