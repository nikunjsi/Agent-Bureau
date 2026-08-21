import { z } from 'zod';
import { EventSchema } from '../../models/event';
import { IdSchema, IsoTimestampSchema } from '../../models/ids';
import { EmptyInputSchema, OkOutputSchema, listOutputSchema } from './common';

export const Activity = {
  query: {
    input: z.object({
      projectId: IdSchema.nullable().default(null),
      type: z.string().nullable().default(null),
      since: IsoTimestampSchema.nullable().default(null),
      limit: z.number().int().positive().max(500).default(100),
    }),
    output: listOutputSchema(EventSchema),
  },
  export: {
    input: z.object({ projectId: IdSchema.nullable().default(null) }),
    output: z.object({ path: z.string() }),
  },
  openRawLog: { input: EmptyInputSchema, output: OkOutputSchema },
};
