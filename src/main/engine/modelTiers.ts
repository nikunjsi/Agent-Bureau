import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ModelTierMapping {
  fast: string;
  balanced: string;
  capable: string;
}

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
