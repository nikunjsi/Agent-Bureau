import { z } from 'zod';
import { UsdDecimalToMicrosSchema } from '../models/money';
/**
 * One engine's tier -> model-id mapping (§7.5). Every tier is optional:
 * overriding one leaves the others on their shipping defaults, and an
 * engine Bureau ships no defaults for can be configured entirely by hand.
 */
const ModelTierMapSchema = z.object({
  fast: z.string().optional(),
  balanced: z.string().optional(),
  capable: z.string().optional(),
});

/**
 * Every setting from §16.1, in one Zod schema, with a default, a scope, and
 * a UI group. "Anything not in this table does not exist" — §16.1. Adding a
 * setting means adding it here (both the value schema below and the
 * `SETTINGS_REGISTRY` metadata) in the same commit.
 *
 * §16.1's "scope" column is prose ("global, overridable per employee",
 * "global, per project", ...), not an enum — modeled here as a structured
 * equivalent: every setting is `global`, and some are additionally
 * overridable at a named narrower scope.
 */
export type SettingOverrideScope = 'employee' | 'project' | 'role' | 'engine';

export type SettingGroup =
  | 'General'
  | 'Prerequisites'
  | 'Engines'
  | 'Company'
  | 'Autonomy'
  | 'Budgets'
  | 'Packs'
  | 'Memory'
  | 'Privacy'
  | 'Advanced'
  | 'Costs'
  | 'About';

export interface SettingMeta {
  readonly group: SettingGroup;
  readonly overridableBy?: readonly SettingOverrideScope[];
  /**
   * True for the handful of settings whose real default can't be computed
   * from the spec alone (depends on the machine, or on engines that don't
   * exist until M3/M13). The Zod schema below still has a placeholder
   * default so parsing never fails; `settingsLoader.ts` (main-process only)
   * overwrites it with the real computed value on first run.
   */
  readonly dynamicDefault?: true;
  /**
   * S-5 (pre-M11): the milestone whose code first reads this setting. Present
   * only while NOTHING in `src/` reads it; the Settings panel then labels it
   * "Not in use yet" and disables it, so a setting that changes nothing is not
   * presented as one that works. `settingsNotYetActive.test.ts` scans `src/`
   * and fails if this marker and the code disagree in either direction.
   */
  readonly inactiveUntil?: 'M11' | 'M12' | 'M13' | 'M14' | 'M15';
}

// Money settings: §16.1 lists these as "decimal→micros" — accepts a decimal
// dollar amount, stored downstream as integer micros (§5.0). The schema
// below does that conversion at parse time, so `SettingsValuesSchema.parse`
// output is already in micros — no separate conversion step anywhere else.
//
// M6 session 2 finding (invariant #12, "money is integer micro-dollars
// everywhere downstream of the config loader" — a real, live violation
// found and fixed here, not part of items 7-9's own scope but load-bearing
// for item 8's budget enforcement): `SettingsValuesSchema` is reused for
// BOTH validating fresh decimal input (setSetting) AND re-deserializing an
// already-stored value (getSetting/getAllSettings). Because `usd()`'s
// schema *transforms* decimal→micros, a value that was already converted
// once at write time gets converted a SECOND time on every read that finds
// a real row — `20.0` becomes `20_000_000` on write, then
// `20_000_000_000_000` on the very next read, silently, for every one of
// these 5 keys, from the moment a database is first seeded (this is not a
// setSetting-only edge case — settingsLoader.ts's own first-boot seeding
// hits it too). `USD_MICROS_SETTING_KEYS` is what
// `repositories/settings.ts` uses to read a *stored* row through
// `UsdMicrosSchema` (identity, no transform) instead of re-running this
// decimal-accepting schema on an already-micros value — the transform
// still runs exactly once, at `setSetting`'s own write time.
const usd = (defaultDecimal: number) => UsdDecimalToMicrosSchema.default(defaultDecimal);

export const USD_MICROS_SETTING_KEYS: ReadonlySet<string> = new Set([
  'budgets.dailyUsd',
  'budgets.projectUsd',
  'budgets.perTaskUsd',
  'budgets.perEmployeeDailyUsd',
  'budgets.directorReserveUsd',
]);

export const SettingsValuesSchema = z.object({
  'general.theme': z.enum(['system', 'light', 'dark']).default('system'),
  // Real default (a resolved path under the user's home directory) is
  // computed by settingsLoader.ts — see `dynamicDefault` in the registry
  // below. node:os / node:path aren't imported here so this file stays
  // usable from renderer code too.
  'general.homeFolder': z.string().default(''),
  'general.notifications': z.boolean().default(true),
  'general.sounds': z.boolean().default(false),
  'general.keepAwake': z.boolean().default(true),
  /**
   * §14.1's splitter position, in CSS pixels — "Splitter is draggable and
   * persisted", and this is the persisted half (AUDIT M0–M2 #17).
   *
   * Default 256 is the `w-64` the pane was hardcoded to before it could be
   * dragged, so an existing user's window does not jump on upgrade. The
   * renderer clamps to a sane range on read as well as on write: a value
   * from a hand-edited settings row, or from a session on a much wider
   * monitor, must not be able to leave a pane that covers the chat.
   */
  'general.floorPaneWidth': z.number().int().min(160).max(720).default(256),

  'director.contextBudgetTokens': z.number().int().default(60_000),
  'director.compactAfterTurns': z.number().int().default(60),
  'director.coalesceWindowSeconds': z.number().int().default(20),

  'intake.maxRounds': z.number().int().default(3),

  'reporting.heartbeatMinutes': z.number().int().default(30),

  'checkpoints.batchWindowSeconds': z.number().int().default(90),
  'checkpoints.blockingTimeoutMinutes': z.number().int().default(60),
  'checkpoints.soonTimeoutHours': z.number().int().default(4),
  'checkpoints.postRestartGraceMinutes': z.number().int().default(10),

  'permissions.maxHoldMinutes': z.number().int().default(30),
  // §7.10 item 3 (M4 session 2): bureau-hook's own self-deadline — strictly
  // LESS than the registered PreToolUse hook timeout the CLI is given
  // (maxHoldMinutes + 5min, computed in claudeCodeAdapter.ts), which is
  // itself the actual fail-closed mechanism: by construction, bureau-hook
  // always answers with a real deny before the engine's own fail-open
  // timeout could ever be the thing that decides. Defaults to
  // maxHoldMinutes converted to ms — the same 5-minute margin the
  // registered timeout adds on top is what keeps this strictly under it,
  // not two independently-tunable numbers that happen to agree today.
  'permissions.hookSelfDeadlineMs': z
    .number()
    .int()
    .default(30 * 60_000),

  'autonomy.default': z.enum(['ask', 'guided', 'autonomous']).default('guided'),

  'budgets.dailyUsd': usd(20.0),
  'budgets.projectUsd': usd(50.0),
  'budgets.perTaskUsd': usd(2.0),
  'budgets.perEmployeeDailyUsd': usd(8.0),
  'budgets.directorReserveUsd': usd(2.0),
  'budgets.warnAtPct': z.number().int().default(80),
  'budgets.onExceed': z.enum(['park', 'ask', 'stop']).default('park'),

  'breaker.enabled': z.boolean().default(true),
  'breaker.tokensPerMinute': z.number().int().default(200_000),
  'breaker.repeatedToolLimit': z.number().int().default(5),
  'breaker.repeatedToolWindowS': z.number().int().default(60),
  'breaker.errorStormLimit': z.number().int().default(8),
  'breaker.steerTimeoutS': z.number().int().default(120),
  'breaker.hardStop': z.boolean().default(false),

  'orchestrator.stallTimeoutS': z.number().int().default(900),
  'orchestrator.maxReassignments': z.number().int().default(2),
  'orchestrator.maxConcurrentEmployees': z.number().int().default(4),
  'orchestrator.idleStopMinutes': z.number().int().default(10),

  'review.autoAcceptTrivialTasks': z.boolean().default(false),
  // AUDIT #28: §16.1 lists this and it was in neither the schema nor the
  // registry, so `autoAcceptTrivialTasks` — which skips a Director review
  // turn "for tasks under a size threshold" (§8.5.1) — had no threshold to
  // read. A switch with no setting for the thing it switches on.
  'review.trivialTaskMaxChangedLines': z.number().int().default(20),

  // Real defaults depend on engine detection (M3/M13) — placeholders here,
  // see `dynamicDefault`.
  'engines.default': z.string().default(''),
  // §7.5: "maps each tier to a concrete model PER ENGINE" — engine key ->
  // tier -> model id. A flat `Record<string,string>` (what this was before
  // AUDIT #1) is structurally unable to express the per-engine half.
  // Partial per engine: overriding one tier leaves the rest on their
  // shipping defaults.
  'engines.modelTiers': z.record(ModelTierMapSchema).default({}),
  'engines.oneshotProvider': z.string().default(''),
  'engines.rateLimitMaxWaitMinutes': z.number().int().default(10),

  'pty.readyDebounceMs': z.number().int().default(150),

  'memory.semanticSearch': z.boolean().default(false),
  'memory.defaultBudgetTokens': z.number().int().default(8000),

  'floor.maxAnimatedSprites': z.number().int().default(24),
  'floor.scale': z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),

  'retention.transcriptDays': z.number().int().default(30),
  'retention.eventTableDays': z.number().int().default(90),
  'retention.memoryProposalDays': z.number().int().default(14),

  'updates.channel': z.enum(['stable', 'beta']).default('stable'),

  'costs.zeroCostMode': z.boolean().default(false),
});

export type SettingsValues = z.infer<typeof SettingsValuesSchema>;
export type SettingKey = keyof SettingsValues;

/** Metadata (group, override scope) for every key above — kept as a
 * separate object rather than crammed into the Zod schema, since Zod has
 * no clean first-class slot for this kind of custom metadata. */
export const SETTINGS_REGISTRY: Record<SettingKey, SettingMeta> = {
  'general.theme': { group: 'General' },
  'general.homeFolder': { group: 'General', dynamicDefault: true },
  'general.notifications': { group: 'General' },
  'general.sounds': { group: 'General', inactiveUntil: 'M13' },
  'general.keepAwake': { group: 'General', inactiveUntil: 'M14' },
  // Advanced rather than General: the user sets this by dragging the
  // splitter, not by typing a pixel count, so it belongs with the other
  // knobs that exist to be inspected rather than operated. §16.1 requires
  // every key to have a group; it does not require every group to be a
  // place a user would go looking.
  'general.floorPaneWidth': { group: 'Advanced' },

  'director.contextBudgetTokens': { group: 'Advanced', inactiveUntil: 'M11' },
  'director.compactAfterTurns': { group: 'Advanced', inactiveUntil: 'M11' },
  'director.coalesceWindowSeconds': { group: 'Advanced' },

  'intake.maxRounds': { group: 'Advanced', inactiveUntil: 'M11' },

  'reporting.heartbeatMinutes': { group: 'General' },

  'checkpoints.batchWindowSeconds': { group: 'Advanced' },
  'checkpoints.blockingTimeoutMinutes': { group: 'Autonomy' },
  'checkpoints.soonTimeoutHours': { group: 'Autonomy' },
  'checkpoints.postRestartGraceMinutes': { group: 'Advanced' },

  'permissions.maxHoldMinutes': { group: 'Autonomy' },
  'permissions.hookSelfDeadlineMs': { group: 'Advanced' },

  'autonomy.default': { group: 'Autonomy', overridableBy: ['employee'] },

  'budgets.dailyUsd': { group: 'Budgets' },
  'budgets.projectUsd': { group: 'Budgets', overridableBy: ['project'] },
  'budgets.perTaskUsd': { group: 'Budgets', overridableBy: ['role'] },
  'budgets.perEmployeeDailyUsd': { group: 'Budgets', overridableBy: ['employee'] },
  'budgets.directorReserveUsd': { group: 'Budgets' },
  'budgets.warnAtPct': { group: 'Budgets' },
  'budgets.onExceed': { group: 'Budgets' },

  'breaker.enabled': { group: 'Autonomy' },
  'breaker.tokensPerMinute': { group: 'Autonomy' },
  'breaker.repeatedToolLimit': { group: 'Autonomy' },
  'breaker.repeatedToolWindowS': { group: 'Autonomy' },
  'breaker.errorStormLimit': { group: 'Autonomy' },
  'breaker.steerTimeoutS': { group: 'Autonomy' },
  'breaker.hardStop': { group: 'Autonomy' },

  'orchestrator.stallTimeoutS': {
    group: 'Advanced',
    overridableBy: ['role'],
    inactiveUntil: 'M11',
  },
  'orchestrator.maxReassignments': {
    group: 'Advanced',
    overridableBy: ['role'],
    inactiveUntil: 'M11',
  },
  'orchestrator.maxConcurrentEmployees': { group: 'Advanced', inactiveUntil: 'M11' },
  'orchestrator.idleStopMinutes': { group: 'Advanced' },

  'review.autoAcceptTrivialTasks': { group: 'Advanced', inactiveUntil: 'M11' },
  'review.trivialTaskMaxChangedLines': { group: 'Advanced', inactiveUntil: 'M11' },

  'engines.default': { group: 'Engines', dynamicDefault: true },
  'engines.modelTiers': { group: 'Engines', dynamicDefault: true },
  'engines.oneshotProvider': { group: 'Engines', dynamicDefault: true },
  'engines.rateLimitMaxWaitMinutes': { group: 'Engines' },

  'pty.readyDebounceMs': { group: 'Advanced', overridableBy: ['engine'], inactiveUntil: 'M14' },

  'memory.semanticSearch': { group: 'Memory' },
  'memory.defaultBudgetTokens': { group: 'Memory', overridableBy: ['role'] },

  'floor.maxAnimatedSprites': { group: 'Advanced', inactiveUntil: 'M12' },
  'floor.scale': { group: 'General', inactiveUntil: 'M12' },

  'retention.transcriptDays': { group: 'Privacy', inactiveUntil: 'M15' },
  'retention.eventTableDays': { group: 'Privacy', inactiveUntil: 'M15' },
  'retention.memoryProposalDays': { group: 'Privacy' },

  'updates.channel': { group: 'About', inactiveUntil: 'M15' },

  'costs.zeroCostMode': { group: 'Budgets' },
};

export const SETTINGS_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];
