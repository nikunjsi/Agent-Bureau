import { z } from 'zod';

/**
 * §7.3/§6.5/§7.1.1: `roles.engine_options` — a single, flat, per-role value,
 * not array-wrapped and not self-tagged with an `engine` field.
 *
 * A role runs under one engine; §7.7's own example spells it
 * `engine: generic-pty` as a sibling, singular field, and there is no
 * multi-engine fallback behaviour anywhere in the spec — a role whose
 * engine is unavailable is disabled, not retried under a different one.
 * So this is not a discriminated-union *array*, and the value itself does
 * not carry its own `engine` tag either: the role's own `engine_preference`
 * is the one source of truth for which engine a role uses, and duplicating
 * that inside this JSON value would create two places that can drift.
 * `engineOptionsSchemaFor(engineKey)` selects the right shape using the
 * role's own field, at the one call site that has both values in hand
 * (`insertRole`) — see roles.ts.
 *
 * Distinct from `EngineModeSchema` (enums.ts), which is the mode an adapter
 * actually ran in and never includes 'auto' — this is the role author's
 * request, which may defer the choice.
 */
export const EngineOptionsModeSchema = z.enum(['auto', 'structured', 'pty']);
export type EngineOptionsMode = z.infer<typeof EngineOptionsModeSchema>;

// `.strict()` on both variants deliberately — not just to catch a pack
// author's typo'd field (reason enough on its own), but because it's load-
// bearing for RoleEngineOptionsSchema's union below: a bare z.object()
// silently *strips* unknown keys rather than rejecting them, so a
// permissive first-tried union member would shadow every other member for
// any input, matching (and quietly truncating) shapes that were never
// meant for it. Strict mode makes each variant genuinely reject anything
// that isn't its own shape, so the union can only ever match the one
// branch that's actually correct — order stops mattering.
// §7.7.1/M3 session 3 correction 3: claude-code is structured-only.
// 'auto' resolves to structured (ClaudeCodeAdapter.resolveMode) and
// requesting it explicitly is fine — 'pty' is rejected here, at
// role-load, with a clear message, rather than silently stalling on a
// second turn with no ready-pattern to detect it (ClaudeCodeAdapter's
// own supportedModes/resolveMode also refuse it, defense in depth,
// §10.3.1). "take control" (§14.5, a later permission) is the trigger to
// revisit — see §7.12.
export const ClaudeCodeEngineOptionsSchema = z
  .object({
    mode: EngineOptionsModeSchema.default('auto'),
  })
  .strict()
  .refine((value) => value.mode !== 'pty', {
    message:
      "claude-code does not support mode:'pty' (§7.7.1 — structured-only; generic-pty exists for CLIs without structured output; PTY mode for claude-code is reserved for the future 'take control' permission, §14.5/§7.12).",
    path: ['mode'],
  });
export type ClaudeCodeEngineOptions = z.infer<typeof ClaudeCodeEngineOptionsSchema>;

export const GenericPtyEngineOptionsSchema = z
  .object({
    mode: EngineOptionsModeSchema.default('auto'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    ready_pattern: z.string().min(1),
    done_pattern: z.string().nullable().default(null),
    interrupt: z.string().default('\x03'),
    ready_debounce_ms: z.number().int().positive().default(150),
  })
  .strict();
export type GenericPtyEngineOptions = z.infer<typeof GenericPtyEngineOptionsSchema>;

/**
 * Read-path shape: matches *a* known engine's options. By the time a row is
 * read back out of the DB, insert-time validation (`engineOptionsSchemaFor`,
 * applied in `insertRole`) has already picked and confirmed the right one
 * for its own engine — this union just needs to accept whichever it was.
 * Nullability is handled at the column-wrapping site (`role.ts`'s
 * `jsonColumnSchema(RoleEngineOptionsSchema).nullable()`, matching
 * `model_preference`'s exact existing pattern) — a role with no
 * customization stores real SQL NULL, not a JSON `null` literal, so this
 * schema itself only ever needs to describe the two real shapes.
 */
export const RoleEngineOptionsSchema = z.union([
  ClaudeCodeEngineOptionsSchema,
  GenericPtyEngineOptionsSchema,
]);
export type RoleEngineOptions = z.infer<typeof RoleEngineOptionsSchema>;

/**
 * Picks the Zod schema for a specific engine key — the actual "discriminated
 * union keyed by engine" this type represents, just resolved externally
 * (via the role's own `engine_preference[0]`) rather than by a field on the
 * value itself. An engine this file doesn't know about yet gets the common
 * mode-only shape rather than throwing — a role naming an engine with no
 * bespoke options schema is not by itself invalid.
 */
export function engineOptionsSchemaFor(engineKey: string) {
  switch (engineKey) {
    case 'claude-code':
      return ClaudeCodeEngineOptionsSchema;
    case 'generic-pty':
      return GenericPtyEngineOptionsSchema;
    default:
      return ClaudeCodeEngineOptionsSchema;
  }
}
