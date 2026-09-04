import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ModelTierSchema, type ModelTier } from '../../shared/models/enums';

const execFileAsync = promisify(execFile);

export interface ModelTierMapping {
  fast: string;
  balanced: string;
  capable: string;
}

/**
 * §7.5: "`settings.modelTiers` maps each tier to a concrete model **per
 * engine**." A partial map is legitimate — a user may override one tier
 * and leave the rest on their shipping defaults.
 */
export type ConfiguredModelTiers = Record<string, { [T in ModelTier]?: string | undefined }>;

/**
 * §7.5's shipping defaults for `claude-code`. Verified against the current
 * model list this session (M3 session 2) — NOT trusted from documentation
 * or training-data knowledge alone, both of which are the same class of
 * evidence as each other, not independent confirmation of anything. See
 * PROGRESS.md for the real `validateModelId` run this session's evidence
 * for these three IDs.
 */
export const CLAUDE_CODE_DEFAULT_MODEL_TIERS: ModelTierMapping = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-5',
  capable: 'claude-opus-5',
};

/**
 * §7.5's shipping defaults, keyed by engine. Only `claude-code` has one:
 * `generic-pty` drives an arbitrary terminal tool that Bureau does not
 * choose a model for at all, so it deliberately has no entry rather than
 * a fabricated one.
 */
export const SHIPPING_MODEL_TIERS: Readonly<Record<string, ModelTierMapping>> = {
  'claude-code': CLAUDE_CODE_DEFAULT_MODEL_TIERS,
};

/**
 * §7.5, the tier a role gets when it declares no preference at all —
 * "`balanced`: the default for most implementation work". Deliberately
 * NOT `fast`: before AUDIT #1 every role of every engine silently ran on
 * the `fast` id, which is what made the whole tier system inert.
 */
const DEFAULT_TIER: ModelTier = 'balanced';

export interface ResolveModelTierInput {
  /** `roles.model_preference` — an ordered list of tier names (§6.5). */
  readonly modelPreference: readonly string[] | null;
  readonly engineKey: string;
  /** `settings.engines.modelTiers`. */
  readonly configured: ConfiguredModelTiers;
}

export interface ResolvedModelTier {
  readonly tier: ModelTier;
  readonly modelId: string;
  /** Which layer supplied the id — recorded on the launch activity event
   *  so "why is this employee on that model" is answerable after the fact. */
  readonly source: 'settings' | 'shipping-default';
}

/**
 * §7.5's resolution, as a pure function: an ordered list of abstract tiers
 * plus the per-engine map resolves to exactly one concrete model id.
 *
 * Walks the role's declared tiers IN ORDER and takes the first that
 * resolves anywhere — a configured mapping first, the engine's shipping
 * default second. Returns `null` when nothing resolves (an engine Bureau
 * ships no defaults for and the user has not configured), which the
 * caller renders as "pass no `--model` and let the engine choose its own".
 */
export function resolveModelTier(input: ResolveModelTierInput): ResolvedModelTier | null {
  const declared = (input.modelPreference ?? []).filter(
    (tier): tier is ModelTier => ModelTierSchema.safeParse(tier).success,
  );
  const tiers: ModelTier[] = declared.length > 0 ? declared : [DEFAULT_TIER];

  const configuredForEngine = input.configured[input.engineKey] ?? {};
  const shippingForEngine = SHIPPING_MODEL_TIERS[input.engineKey];

  for (const tier of tiers) {
    const fromSettings = configuredForEngine[tier];
    if (fromSettings) return { tier, modelId: fromSettings, source: 'settings' };
    const fromShipping = shippingForEngine?.[tier];
    if (fromShipping) return { tier, modelId: fromShipping, source: 'shipping-default' };
  }
  return null;
}

// Starting at the 4.6 generation, model IDs are dateless pinned snapshots
// (`claude-sonnet-5`, `claude-opus-5` — no trailing date). Older IDs carry
// a major-minor pair before an optional date (`claude-haiku-4-5-20251001`:
// "4-5" is the version, spelled with a dash rather than a dot). A regex
// requiring exactly one numeric segment before an optional 8-digit date
// would wrongly reject the older, still-valid dated form.
const PLAUSIBLE_MODEL_ID_PATTERN = /^claude-[a-z]+-\d+(-\d+)*(-\d{8})?$/;

/**
 * A cheap, free, purely-syntactic sanity check — catches an obviously
 * malformed ID (typo, wrong product's naming scheme) without spending
 * anything. This is NOT validation: a plausible-looking ID can still be
 * retired, renamed, or never have existed. `validateModelId` below is the
 * only real check.
 */
export function looksLikeValidModelId(modelId: string): boolean {
  return PLAUSIBLE_MODEL_ID_PATTERN.test(modelId);
}

export interface ModelValidationResult {
  modelId: string;
  valid: boolean;
  error: string | null;
}

/**
 * The only real verification a model ID is currently valid and usable is
 * the engine actually accepting it — spawns a real, minimal `-p` call.
 * Deliberately NOT invoked automatically anywhere (not at adapter
 * construction, not per-spawn, not on every Bureau startup): it costs a
 * small amount of real money per call. Meant to be run on demand (M13's
 * settings UI, eventually) — this session runs it manually, a handful of
 * times, to produce real evidence rather than trusting
 * CLAUDE_CODE_DEFAULT_MODEL_TIERS blind.
 *
 * Cost discipline (COST section, M3 session 2 prompt): one-word prompt,
 * `max_turns: 1`, `--permission-mode dontAsk` with no allow-list (so even
 * if the model tried a tool call, nothing could execute), a hard
 * `--max-budget-usd` cap as a second, independent ceiling, and a spawn cwd
 * with no `.mcp.json` in it.
 */
export async function validateModelId(
  claudeBinaryPath: string,
  modelId: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBudgetUsd?: number; timeoutMs?: number },
): Promise<ModelValidationResult> {
  const maxBudgetUsd = options.maxBudgetUsd ?? 0.02;
  try {
    const { stdout } = await execFileAsync(
      claudeBinaryPath,
      [
        '-p',
        'Reply with exactly one word: OK',
        '--model',
        modelId,
        '--max-turns',
        '1',
        '--output-format',
        'json',
        '--permission-mode',
        'dontAsk',
        '--allowed-tools',
        '', // empty — nothing is allowed to execute even if requested
        '--strict-mcp-config',
        '--setting-sources',
        '', // no user/project/local settings sources — a clean, isolated call
        '--max-budget-usd',
        String(maxBudgetUsd),
      ],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? 30_000 },
    );
    const result: unknown = JSON.parse(stdout);
    const isError =
      typeof result === 'object' &&
      result !== null &&
      'is_error' in result &&
      (result as { is_error: unknown }).is_error === true;
    if (isError) {
      const message =
        typeof result === 'object' && result !== null && 'result' in result
          ? String((result as { result: unknown }).result)
          : 'unknown error';
      return { modelId, valid: false, error: message };
    }
    return { modelId, valid: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { modelId, valid: false, error: message };
  }
}

/** Validates every tier's model ID, sequentially (never in parallel — no reason to burst-spend). */
export async function validateModelTiers(
  claudeBinaryPath: string,
  tiers: ModelTierMapping,
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBudgetUsd?: number },
): Promise<ModelValidationResult[]> {
  const results: ModelValidationResult[] = [];
  for (const modelId of Object.values(tiers)) {
    results.push(await validateModelId(claudeBinaryPath, modelId, options));
  }
  return results;
}
