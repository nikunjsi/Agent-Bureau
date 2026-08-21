import { z } from 'zod';
import { IdSchema } from '../../models/ids';
import { UsdMicrosSchema } from '../../models/money';
import { EmptyInputSchema, listOutputSchema } from './common';

/**
 * New namespace (see the M2 plan / PROGRESS.md): §16's whole "Costs"
 * settings group — "spend by day / project / employee / role, budget
 * usage bars, the top-10 most expensive tasks, and the model pricing
 * table in force" — had no IPC surface at all in §17.1's original code
 * block. `summary`/`byProject`/`byEmployee`/`byRole`/`topTasks` are
 * plain aggregation over M1's `usage`/`tasks`/`projects` tables — no
 * pricing engine needed for *reported* spend, so these are real in M2.
 * `pricingTable` needs M6's actual pricing table and stays a stub until
 * then.
 */
const DailySpendSchema = z.object({ date: z.string(), usdMicros: UsdMicrosSchema });

const CostSummarySchema = z.object({
  totalUsdMicros: UsdMicrosSchema,
  todayUsdMicros: UsdMicrosSchema,
  byDay: z.array(DailySpendSchema),
});

const NamedSpendSchema = z.object({ id: z.string(), label: z.string(), usdMicros: UsdMicrosSchema });

const TaskSpendSchema = z.object({
  taskId: IdSchema,
  displayKey: z.string(),
  title: z.string(),
  usdMicros: UsdMicrosSchema,
});

const PricingRowSchema = z.object({
  engine: z.string(),
  model: z.string(),
  tier: z.enum(['fast', 'balanced', 'capable']),
  inputPerMTokUsdMicros: UsdMicrosSchema,
  outputPerMTokUsdMicros: UsdMicrosSchema,
});

export const Costs = {
  summary: { input: z.object({ projectId: IdSchema.nullable().default(null) }), output: z.object({ item: CostSummarySchema }) },
  byProject: { input: EmptyInputSchema, output: listOutputSchema(NamedSpendSchema) },
  byEmployee: { input: EmptyInputSchema, output: listOutputSchema(NamedSpendSchema) },
  byRole: { input: EmptyInputSchema, output: listOutputSchema(NamedSpendSchema) },
  topTasks: { input: z.object({ limit: z.number().int().positive().max(50).default(10) }), output: listOutputSchema(TaskSpendSchema) },
  /** Stub — no pricing table exists until M6 (§11.5.1). */
  pricingTable: { input: EmptyInputSchema, output: listOutputSchema(PricingRowSchema) },
};
