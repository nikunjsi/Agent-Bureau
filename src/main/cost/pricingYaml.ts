import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PricingTableSchema, type PricingTable } from '../../shared/models/pricing';
import { usdToMicros, type UsdMicros } from '../../shared/models/money';

/** Real YAML parse + Zod validate — `resources/pricing.yaml`'s own
 * location is resolved by `resourceScripts.ts`'s `resolvePricingYamlPath`
 * (the same dev-vs-packaged split every other resource file uses), not
 * this function's concern. */
export function loadPricingYaml(filePath: string): PricingTable {
  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = parse(raw);
  return PricingTableSchema.parse(parsed);
}

export interface TokenUsageForCost {
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
}

/**
 * §11.5.1: `null`, never `0`, when no rate entry exists for this
 * engine+model — "cost not reported" honesty, the same discipline
 * `getUsageSummaryForTask` already uses for its own null-not-zero rule.
 * `model === null` (an engine that never reports which model it used)
 * is the same "cannot compute" case, not a 0-rate lookup.
 *
 * Computed in integer micros throughout (invariant #12) — each rate is
 * converted from decimal-USD-per-million-tokens to integer-micros-per-
 * million-tokens exactly once (`usdToMicros`), the four token categories'
 * contributions are summed as integers, and the division by 1,000,000
 * (tokens-per-million) happens exactly once, at the end, with a single
 * rounding — not once per category, which would compound rounding error
 * across four separate roundings for one turn's cost.
 */
export function computeCostFromTokens(
  pricing: PricingTable,
  engine: string,
  model: string | null,
  usage: TokenUsageForCost,
): UsdMicros | null {
  if (model === null) return null;
  const rates = pricing.engines[engine]?.models[model];
  if (!rates) return null;

  const numerator =
    (usage.tokensIn ?? 0) * usdToMicros(rates.input_usd_per_million) +
    (usage.tokensOut ?? 0) * usdToMicros(rates.output_usd_per_million) +
    (usage.tokensCacheRead ?? 0) * usdToMicros(rates.cache_read_usd_per_million) +
    (usage.tokensCacheWrite ?? 0) * usdToMicros(rates.cache_write_usd_per_million);

  return Math.round(numerator / 1_000_000);
}
