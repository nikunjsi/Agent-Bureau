import { z } from 'zod';
import { UsdDecimalToMicrosSchema } from '../models/money';

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
}

// Money settings: §16.1 lists these as "decimal→micros" — accepts a decimal
// dollar amount, stored downstream as integer micros (§5.0). The schema
// below does that conversion at parse time, so `SettingsValuesSchema.parse`
// output is already in micros — no separate conversion step anywhere else.
const usd = (defaultDecimal: number) => UsdDecimalToMicrosSchema.default(defaultDecimal);

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

  // Real defaults depend on engine detection (M3/M13) — placeholders here,
  // see `dynamicDefault`.
  'engines.default': z.string().default(''),
  'engines.modelTiers': z.record(z.string()).default({}),
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
  'general.sounds': { group: 'General' },
  'general.keepAwake': { group: 'General' },

  'director.contextBudgetTokens': { group: 'Advanced' },
  'director.compactAfterTurns': { group: 'Advanced' },
  'director.coalesceWindowSeconds': { group: 'Advanced' },

  'intake.maxRounds': { group: 'Advanced' },

  'reporting.heartbeatMinutes': { group: 'General' },

  'checkpoints.batchWindowSeconds': { group: 'Advanced' },
  'checkpoints.blockingTimeoutMinutes': { group: 'Autonomy' },
  'checkpoints.soonTimeoutHours': { group: 'Autonomy' },
  'checkpoints.postRestartGraceMinutes': { group: 'Advanced' },

  'permissions.maxHoldMinutes': { group: 'Autonomy' },

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

  'orchestrator.stallTimeoutS': { group: 'Advanced', overridableBy: ['role'] },
  'orchestrator.maxReassignments': { group: 'Advanced', overridableBy: ['role'] },
  'orchestrator.maxConcurrentEmployees': { group: 'Advanced' },
  'orchestrator.idleStopMinutes': { group: 'Advanced' },

  'review.autoAcceptTrivialTasks': { group: 'Advanced' },

  'engines.default': { group: 'Engines', dynamicDefault: true },
  'engines.modelTiers': { group: 'Engines', dynamicDefault: true },
  'engines.oneshotProvider': { group: 'Engines', dynamicDefault: true },
  'engines.rateLimitMaxWaitMinutes': { group: 'Engines' },

  'pty.readyDebounceMs': { group: 'Advanced', overridableBy: ['engine'] },

  'memory.semanticSearch': { group: 'Memory' },
  'memory.defaultBudgetTokens': { group: 'Memory', overridableBy: ['role'] },

  'floor.maxAnimatedSprites': { group: 'Advanced' },
  'floor.scale': { group: 'General' },

  'retention.transcriptDays': { group: 'Privacy' },
  'retention.eventTableDays': { group: 'Privacy' },
  'retention.memoryProposalDays': { group: 'Privacy' },

  'updates.channel': { group: 'About' },

  'costs.zeroCostMode': { group: 'Budgets' },
};

export const SETTINGS_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];
