import { z } from 'zod';
import { CheckpointSchema } from '../../models/checkpoint';
import { IdSchema } from '../../models/ids';
import { EmptyInputSchema, IdInputSchema, OkOutputSchema, listOutputSchema, nullableGetOutputSchema } from './common';

export const Checkpoints = {
  listPending: { input: EmptyInputSchema, output: listOutputSchema(CheckpointSchema) },
  get: { input: IdInputSchema, output: nullableGetOutputSchema(CheckpointSchema) },
  answer: {
    input: z.object({ id: IdSchema, optionId: z.string().optional(), freeText: z.string().optional() }),
    output: OkOutputSchema,
  },
  answerPermission: { input: z.object({ id: IdSchema, allow: z.boolean() }), output: OkOutputSchema },
};
