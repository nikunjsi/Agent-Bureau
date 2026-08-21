import { z } from 'zod';
import { DeliverableSchema } from '../../models/deliverable';
import { IdSchema } from '../../models/ids';
import { IdInputSchema, OkOutputSchema, listOutputSchema, nullableGetOutputSchema } from './common';

export const Deliverables = {
  list: { input: z.object({ projectId: IdSchema }), output: listOutputSchema(DeliverableSchema) },
  get: { input: IdInputSchema, output: nullableGetOutputSchema(DeliverableSchema) },
  accept: { input: IdInputSchema, output: OkOutputSchema },
  reject: { input: z.object({ id: IdSchema, feedback: z.string().min(1) }), output: OkOutputSchema },
  openFolder: { input: IdInputSchema, output: OkOutputSchema },
};
