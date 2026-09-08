import { z } from 'zod';
import { TaskSchema } from '../../models/task';
import { IdSchema } from '../../models/ids';
import { IdInputSchema, OkOutputSchema, listOutputSchema, nullableGetOutputSchema } from './common';

export const Tasks = {
  list: {
    input: z.object({ projectId: IdSchema.nullable().default(null) }),
    output: listOutputSchema(TaskSchema),
  },
  get: { input: IdInputSchema, output: nullableGetOutputSchema(TaskSchema) },
  cancel: { input: IdInputSchema, output: OkOutputSchema },
  retry: { input: IdInputSchema, output: OkOutputSchema },
  reassign: { input: z.object({ id: IdSchema, employeeId: IdSchema }), output: OkOutputSchema },
};
