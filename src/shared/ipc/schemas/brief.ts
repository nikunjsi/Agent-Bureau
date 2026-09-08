import { z } from 'zod';
import { BriefSchema } from '../../models/brief';
import { IdSchema } from '../../models/ids';
import { IdInputSchema, OkOutputSchema, nullableGetOutputSchema } from './common';

export const Brief = {
  get: { input: z.object({ projectId: IdSchema }), output: nullableGetOutputSchema(BriefSchema) },
  approve: { input: IdInputSchema, output: OkOutputSchema },
  requestEdit: {
    input: z.object({ id: IdSchema, feedback: z.string().min(1) }),
    output: OkOutputSchema,
  },
  saveEdit: { input: z.object({ id: IdSchema, markdown: z.string() }), output: OkOutputSchema },
};
