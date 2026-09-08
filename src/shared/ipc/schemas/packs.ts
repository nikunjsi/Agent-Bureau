import { z } from 'zod';
import { EmptyInputSchema, OkOutputSchema, listOutputSchema } from './common';

/**
 * §6.3's `pack.yaml` shape, summarized for the UI. No M1 repository backs
 * this — packs aren't part of the §5.1 schema at all; M7 owns the real
 * install/validate/scaffold logic and the on-disk `packs/` layout (§6.2).
 * This is a reasonable placeholder shape M7 can adjust, not a load-bearing
 * contract yet.
 */
export const PackInfoSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  enabled: z.boolean(),
  departments: z.array(z.string()),
});

export const Packs = {
  list: { input: EmptyInputSchema, output: listOutputSchema(PackInfoSchema) },
  install: { input: z.object({ source: z.string().min(1) }), output: OkOutputSchema },
  validate: {
    input: z.object({ source: z.string().min(1) }),
    output: z.object({ valid: z.boolean(), errors: z.array(z.string()) }),
  },
  scaffold: { input: z.object({ name: z.string().min(1) }), output: OkOutputSchema },
  setEnabled: {
    input: z.object({ key: z.string().min(1), enabled: z.boolean() }),
    output: OkOutputSchema,
  },
};
