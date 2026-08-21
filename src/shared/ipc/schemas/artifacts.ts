import { z } from 'zod';
import { ArtifactSchema } from '../../models/artifact';
import { IdSchema } from '../../models/ids';
import { IdInputSchema, listOutputSchema, nullableGetOutputSchema } from './common';

export const Artifacts = {
  listForTask: { input: z.object({ taskId: IdSchema }), output: listOutputSchema(ArtifactSchema) },
  get: { input: IdInputSchema, output: nullableGetOutputSchema(ArtifactSchema) },
};
