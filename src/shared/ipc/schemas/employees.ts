import { z } from 'zod';
import { EmployeeSchema } from '../../models/employee';
import { AutonomySchema, ModelTierSchema } from '../../models/enums';
import { IdSchema } from '../../models/ids';
import { UsdMicrosSchema } from '../../models/money';
import { EmptyInputSchema, IdInputSchema, OkOutputSchema, listOutputSchema, nullableGetOutputSchema } from './common';

export const Employees = {
  list: { input: EmptyInputSchema, output: listOutputSchema(EmployeeSchema) },
  get: { input: IdInputSchema, output: nullableGetOutputSchema(EmployeeSchema) },
  pause: { input: IdInputSchema, output: OkOutputSchema },
  // Named resumeEmployee, not resume, in §17.1 — avoids any ambiguity with
  // projects.resume when both appear in generated code/logs.
  resumeEmployee: { input: IdInputSchema, output: OkOutputSchema },
  interrupt: { input: IdInputSchema, output: OkOutputSchema },
  updateSettings: {
    input: z.object({
      id: IdSchema,
      autonomy: AutonomySchema.optional(),
      dailyBudgetUsdMicros: UsdMicrosSchema.nullable().optional(),
      /**
       * A TIER, not a model id — changed 2026-09-07 by the M7→M4 boundary
       * check's fix.
       *
       * This was `model: string | null` and wrote `employees.model`, which
       * nothing read: the Supervisor re-resolved from the role and
       * overwrote it, so the setting was inert. It is a tier now for the
       * same reason the hire-time override is (§7.5, migration 0008) — a
       * pinned id stops tracking the role, stops tracking
       * `settings.engines.modelTiers`, and is meaningless across engines.
       *
       * `null` clears the override and returns the employee to the role's
       * own `model_preference`, which is what "reset to default" means
       * here and is why this stayed a settable field rather than being
       * removed: choosing a tier per employee is a real thing a user
       * wants, it simply had no working implementation.
       */
      modelTierOverride: ModelTierSchema.nullable().optional(),
    }),
    output: OkOutputSchema,
  },
  // §14.5: taking control first calls interrupt(), then blocks Bureau's
  // own send() until control is released — the ordering itself is a
  // supervisor concern (M3+); M2 validates the request/response shape.
  takeControl: { input: IdInputSchema, output: OkOutputSchema },
  releaseControl: { input: IdInputSchema, output: OkOutputSchema },
  // Raw keystrokes to the pty while the user holds control.
  sendInput: { input: z.object({ id: IdSchema, data: z.string() }), output: OkOutputSchema },
  // §17.2: "required, not optional" — xterm.js must report cols/rows on
  // every resize.
  resizePty: {
    input: z.object({ id: IdSchema, cols: z.number().int().positive(), rows: z.number().int().positive() }),
    output: OkOutputSchema,
  },
};
