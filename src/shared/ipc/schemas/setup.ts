import { z } from 'zod';
import { PrereqSchema } from '../../models/prereq';
import { EmptyInputSchema, OkOutputSchema, listOutputSchema } from './common';

/** §15's wizard state — M2 builds the transport only; the wizard itself
 * (detection flows, install streaming, the scanner) is M13. */
export const SetupStateSchema = z.object({
  currentStep: z.number().int().min(1).max(8),
  homeFolderSet: z.boolean(),
  engineConnected: z.boolean(),
  completed: z.boolean(),
});

export const Setup = {
  getState: { input: EmptyInputSchema, output: z.object({ item: SetupStateSchema }) },
  detectPrereqs: { input: EmptyInputSchema, output: listOutputSchema(PrereqSchema) },
  installPrereq: { input: z.object({ key: z.string().min(1) }), output: OkOutputSchema },
  connectEngine: {
    input: z.object({ engine: z.string().min(1), method: z.enum(['subscription', 'apiKey']) }),
    output: OkOutputSchema,
  },
  setHomeFolder: { input: z.object({ path: z.string().min(1) }), output: OkOutputSchema },
  complete: { input: EmptyInputSchema, output: OkOutputSchema },
};
