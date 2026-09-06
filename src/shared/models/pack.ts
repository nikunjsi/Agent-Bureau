import { z } from 'zod';
import { AutonomySchema, ModelTierSchema, RoleDeliverableKindSchema } from './enums';
import { IsoTimestampSchema } from './ids';
import { StrictSemverSchema } from './semver';

/**
 * §6.2-§6.5 — a pack's on-disk YAML, as Zod. This is the boundary where
 * user-authorable content becomes something the engine will act on, so it is
 * strict by default: unknown keys are rejected rather than ignored, because a
 * silently-dropped `tools_deny` typo is exactly the failure §6.7 exists to
 * prevent.
 *
 * Lives in `src/shared/models/` following the same convention as
 * `pricing.ts` — the schema is shared, the file-reading loader is
 * `src/main/packs/loadPack.ts` and owns no schema of its own.
 */

/** §6.5 — an ordered list of ABSTRACT tiers (§7.5), never concrete model ids. */
const ModelTierArraySchema = z.array(ModelTierSchema);

/**
 * §6.5's `input_types` — what a role CONSUMES, mirroring `deliverable_types`
 * (what it produces). Deliberately format-agnostic: Bureau does not parse these
 * itself (the engine's own Read tool does), but it must not silently exclude a
 * format either. `[]` means "no declared restriction", not "nothing".
 *
 * Added at M7 because role YAML's shape is frozen here; the reference-material
 * feature that reads it is M13/M14 (§15.2's folder scanner going format-aware).
 */
export const RoleInputKindSchema = z.enum([
  'code',
  'document',
  'spreadsheet',
  'image',
  'pdf',
  'any',
]);
export type RoleInputKind = z.infer<typeof RoleInputKindSchema>;

/**
 * §6.7 check 6 — the schema a pack declares for its own roles'
 * `role_options`. Deliberately a flat key→primitive-type map rather than
 * embedded JSON Schema: a full JSON Schema implementation is not warranted for
 * validating a handful of pack-authored scalars, and a small, total, obvious
 * shape is easier for a pack author to get right than a subset of a large one.
 */
export const RoleOptionsSchemaDeclSchema = z.record(z.enum(['string', 'number', 'boolean']));
export type RoleOptionsSchemaDecl = z.infer<typeof RoleOptionsSchemaDeclSchema>;

/** §6.3 — `pack.yaml`. */
export const PackManifestSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase alphanumeric with dashes'),
    name: z.string().min(1),
    version: StrictSemverSchema,
    description: z.string().default(''),
    author: z.string().default(''),
    license: z.string().default(''),
    /** §6.7 check 1. Strict shape — see semver.ts for why. */
    bureau_min_version: StrictSemverSchema,
    departments: z.array(z.string().min(1)).min(1),
    requires: z
      .object({
        tools: z.array(z.string().min(1)).default([]),
        engines: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ tools: [], engines: [] }),
    project_kinds: z.array(z.string().min(1)).default([]),
    /** §6.7 check 6 — optional; absent means role_options is only checked to be an object. */
    role_options_schema: RoleOptionsSchemaDeclSchema.optional(),
  })
  .strict();
export type PackManifest = z.infer<typeof PackManifestSchema>;

/** §6.4 — `departments/<key>.yaml`. */
export const DepartmentYamlSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(''),
    roles: z.array(z.string().min(1)).min(1),
    room: z
      .object({
        preferred_size: z
          .object({ w: z.number().int().positive(), h: z.number().int().positive() })
          .strict(),
        theme: z
          .object({
            floor: z.string().min(1),
            wall: z.string().min(1),
            props: z.array(z.string().min(1)).default([]),
          })
          .strict()
          .optional(),
      })
      .strict(),
    /** §6.4 — who exists when this department is first added. */
    default_hires: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type DepartmentYaml = z.infer<typeof DepartmentYamlSchema>;

/**
 * §6.5 — `roles/<key>.yaml`, the full reference.
 *
 * `escalate_when` and `reports` are required and non-empty on purpose: §6.5
 * describes them as what makes an employee behave like a colleague rather than
 * a text generator, and a role that declares neither has no defined behaviour
 * when it gets stuck.
 */
export const RoleYamlSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    department: z.string().min(1),
    version: StrictSemverSchema,
    description: z.string().min(1),

    system_prompt_path: z.string().min(1),
    shared_prompts: z.array(z.string().min(1)).default([]),

    skills: z.array(z.string().min(1)).default([]),
    deliverable_types: z.array(RoleDeliverableKindSchema).default([]),
    input_types: z.array(RoleInputKindSchema).default([]),

    engine_preference: z.array(z.string().min(1)).min(1),
    model_preference: ModelTierArraySchema.default([]),
    engine_options: z.record(z.unknown()).nullable().default(null),

    tools_allow: z.array(z.string().min(1)).default([]),
    tools_deny: z.array(z.string().min(1)).default([]),

    /**
     * §6.5: domain globs. **Empty is a real, meaningful value** — it means this
     * role gets no network tools at all, not "unset". §6.7 check 4a is what
     * enforces the pairing with an actually-granted network tool.
     */
    network_allow: z.array(z.string().min(1)).default([]),

    memory_scopes: z.array(z.string().min(1)).default([]),
    memory_budget_tokens: z.number().int().positive().default(8000),

    autonomy_default: AutonomySchema,
    max_turns: z.number().int().positive().default(40),
    max_attempts: z.number().int().positive().default(2),
    wall_clock_timeout_s: z.number().int().positive().default(2400),
    budget_usd: z.number().nonnegative().nullable().default(null),

    escalate_when: z.array(z.string().min(1)).min(1),
    reports: z
      .object({
        on_complete: z.string().min(1),
        on_block: z.string().min(1),
      })
      .strict(),

    sprite_key: z.string().min(1),
    role_options: z.record(z.unknown()).default({}),
  })
  .strict();
export type RoleYaml = z.infer<typeof RoleYamlSchema>;

/** What `loadPack` produces on success: the parsed content, plus where it came from. */
export interface ParsedPack {
  readonly rootDir: string;
  readonly manifest: PackManifest;
  readonly departments: readonly DepartmentYaml[];
  readonly roles: readonly RoleYaml[];
}

// --- the `packs` DB row (migration 0006) --------------------------------

/**
 * Bundled packs ship inside the installer and are read-only; user packs
 * live under `%APPDATA%/Bureau/packs/` and are writable. Only one of the
 * two can be uninstalled, so this is not cosmetic.
 */
export const PackOriginSchema = z.enum(['bundled', 'user']);
export type PackOrigin = z.infer<typeof PackOriginSchema>;

export const PackValidationStatusSchema = z.enum(['ok', 'failed']);
export type PackValidationStatus = z.infer<typeof PackValidationStatusSchema>;

export const PackRowSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  origin: PackOriginSchema,
  /** Provenance — where it came FROM, not where it lives. */
  source_path: z.string().min(1),
  installed_at: IsoTimestampSchema,
  /**
   * The user's intent, never rewritten by the system. A pack that fails
   * validation at boot stays `enabled` and is withheld with a reason — see
   * the migration for why a silent flip would be worse.
   */
  enabled: z.coerce.boolean(),
  last_validation_status: PackValidationStatusSchema,
  last_validation_error: z.string().nullable(),
  last_validated_at: IsoTimestampSchema.nullable(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type PackRow = z.infer<typeof PackRowSchema>;

export const NewPackInputSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  origin: PackOriginSchema,
  source_path: z.string().min(1),
  enabled: z.boolean().default(true),
  last_validation_status: PackValidationStatusSchema.default('ok'),
  last_validation_error: z.string().nullable().default(null),
});
export type NewPackInput = z.input<typeof NewPackInputSchema>;
