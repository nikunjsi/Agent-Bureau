import { z } from 'zod';
import { PlanSchema } from '../../models/plan';
import { IdSchema } from '../../models/ids';
import { IdInputSchema, OkOutputSchema, nullableGetOutputSchema } from './common';

export const Plan = {
  get: { input: z.object({ projectId: IdSchema }), output: nullableGetOutputSchema(PlanSchema) },
  approve: { input: IdInputSchema, output: OkOutputSchema },
  requestEdit: {
    input: z.object({ id: IdSchema, feedback: z.string().min(1) }),
    output: OkOutputSchema,
  },
};
