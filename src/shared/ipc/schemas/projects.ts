import { z } from 'zod';
import { ProjectSchema } from '../../models/project';
import { ProjectKindSchema } from '../../models/enums';
import { IdSchema } from '../../models/ids';
import { UsdMicrosSchema } from '../../models/money';
import { EmptyInputSchema, IdInputSchema, OkOutputSchema, listOutputSchema, nullableGetOutputSchema } from './common';

export const Projects = {
  list: { input: EmptyInputSchema, output: listOutputSchema(ProjectSchema) },
  get: { input: IdInputSchema, output: nullableGetOutputSchema(ProjectSchema) },
  create: {
    input: z.object({ name: z.string().min(1), path: z.string().min(1), kind: ProjectKindSchema }),
    output: z.object({ item: ProjectSchema }),
  },
  open: { input: IdInputSchema, output: OkOutputSchema },
  pause: { input: IdInputSchema, output: OkOutputSchema },
  resume: { input: IdInputSchema, output: OkOutputSchema },
  abandon: { input: IdInputSchema, output: OkOutputSchema },
  setBudget: { input: z.object({ id: IdSchema, budgetUsdMicros: UsdMicrosSchema }), output: OkOutputSchema },
  /** §16 Privacy & Data: "export everything" — a project-scoped export.
   * Not in §17.1's original code block; see the M2 plan/PROGRESS.md. */
  exportData: { input: IdInputSchema, output: z.object({ path: z.string() }) },
  /** §16 Privacy & Data: "delete a project's data." Same origin as above. */
  deleteData: { input: IdInputSchema, output: OkOutputSchema },
};
