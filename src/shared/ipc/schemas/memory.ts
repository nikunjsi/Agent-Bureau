import { z } from 'zod';
import { MemorySchema } from '../../models/memory';
import { MemoryScopeSchema } from '../../models/enums';
import { IdInputSchema, OkOutputSchema, listOutputSchema, nullableGetOutputSchema } from './common';

export const Memory = {
  list: {
    input: z.object({ scope: MemoryScopeSchema.optional(), scopeRef: z.string().nullable().optional() }),
    output: listOutputSchema(MemorySchema),
  },
  read: { input: IdInputSchema, output: nullableGetOutputSchema(MemorySchema) },
  write: {
    input: z.object({ scope: MemoryScopeSchema, path: z.string().min(1), title: z.string().min(1), body: z.string() }),
    output: z.object({ item: MemorySchema }),
  },
  remove: { input: IdInputSchema, output: OkOutputSchema },
  search: { input: z.object({ query: z.string().min(1) }), output: listOutputSchema(MemorySchema) },
  reindex: { input: z.object({}), output: OkOutputSchema },
};
