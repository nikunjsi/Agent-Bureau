import { z } from 'zod';
import { PhaseSchema } from '../../models/phase';
import { IdSchema } from '../../models/ids';
import { IdInputSchema, OkOutputSchema, listOutputSchema, nullableGetOutputSchema } from './common';

export const Phases = {
  list: { input: z.object({ planId: IdSchema }), output: listOutputSchema(PhaseSchema) },
  get: { input: IdInputSchema, output: nullableGetOutputSchema(PhaseSchema) },
  submitReview: { input: IdInputSchema, output: OkOutputSchema },
  accept: { input: IdInputSchema, output: OkOutputSchema },
  requestChanges: {
    input: z.object({ id: IdSchema, feedback: z.string().min(1) }),
    output: OkOutputSchema,
  },
};
