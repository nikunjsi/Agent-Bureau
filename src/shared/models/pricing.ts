import { z } from 'zod';

/** §11.5.1: "resources/pricing.yaml, versioned, mapping engine + model →
 * per-million-token rates for input, output, cache-read and cache-write."
 * Values are decimal USD-per-million-tokens as written in the YAML file
 * (e.g. `5.00`) — converted to integer micros at load time
 * (`pricingYaml.ts`'s own job), never stored as a float downstream of
 * that (invariant #12). */
export const ModelRatesSchema = z.object({
  input_usd_per_million: z.number().nonnegative(),
  output_usd_per_million: z.number().nonnegative(),
  cache_write_usd_per_million: z.number().nonnegative(),
  cache_read_usd_per_million: z.number().nonnegative(),
});
export type ModelRates = z.infer<typeof ModelRatesSchema>;

/**
 * §24.3: "either a daily wall-clock time in a named timezone, or a
 * rolling window. If the provider's reset behaviour is unknown, do not
 * invent one." Three real shapes, not two-plus-a-null — `unknown` is a
 * first-class, explicit value a pricing.yaml author states deliberately,
 * not something the absence of a field would leave ambiguous.
 */
export const QuotaResetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), hour: z.number().int().min(0).max(23), timezone: z.string().min(1) }),
  z.object({ kind: z.literal('rolling'), window_minutes: z.number().int().positive() }),
  z.object({ kind: z.literal('unknown') }),
]);
export type QuotaReset = z.infer<typeof QuotaResetSchema>;

export const EnginePricingSchema = z.object({
  models: z.record(ModelRatesSchema),
  quota_reset: QuotaResetSchema,
});
export type EnginePricing = z.infer<typeof EnginePricingSchema>;

export const PricingTableSchema = z.object({
  version: z.number().int(),
  verified_at: z.string().min(1),
  verified_against: z.string().min(1),
  engines: z.record(EnginePricingSchema),
});
export type PricingTable = z.infer<typeof PricingTableSchema>;
