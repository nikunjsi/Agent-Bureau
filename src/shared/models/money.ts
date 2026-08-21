import { z } from 'zod';

/**
 * Money is stored in micro-dollars as INTEGER, never floats (§5.0). This is
 * the one conversion boundary — everything downstream of it (every model,
 * every repository, every future budget/cost calculation) works in integer
 * micros only. Config/settings accept decimals and convert here, at load.
 */
export type UsdMicros = number;

const MICROS_PER_USD = 1_000_000;

/** Parses a decimal dollar amount (`"20.00"`, `20`, `20.5`) into integer micros. */
export function usdToMicros(value: number | string): UsdMicros {
  const decimal = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(decimal)) {
    throw new Error(`usdToMicros: not a finite number: ${JSON.stringify(value)}`);
  }
  return Math.round(decimal * MICROS_PER_USD);
}

/** The inverse of `usdToMicros`, for display only — never for storage. */
export function microsToUsd(micros: UsdMicros): number {
  return micros / MICROS_PER_USD;
}

/**
 * A settings/config-facing schema: accepts a decimal number or numeric
 * string and yields integer micros. Use this for every `decimal→micros`
 * setting (§16.1) and anywhere else a human enters a dollar amount.
 */
export const UsdDecimalToMicrosSchema = z
  .union([z.number(), z.string()])
  .transform((value) => usdToMicros(value));

/** A schema for a column that is already stored as integer micros. */
export const UsdMicrosSchema = z.number().int();
