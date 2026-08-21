import { z } from 'zod';
import { EmployeeSchema } from '../../models/employee';
import { AutonomySchema } from '../../models/enums';
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
      model: z.string().nullable().optional(),
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
