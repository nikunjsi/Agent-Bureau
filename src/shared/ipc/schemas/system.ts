import { z } from 'zod';
import { HealthResultSchema } from '../health';
import { EmptyInputSchema, OkOutputSchema } from './common';

const ScanResultSchema = z.object({
  languages: z.array(z.string()),
  framework: z.string().nullable(),
  testSetup: z.string().nullable(),
  packageManager: z.string().nullable(),
  isGitRepo: z.boolean(),
  gitBranch: z.string().nullable(),
  readmeExcerpt: z.string().nullable(),
});

export const System = {
  health: { input: EmptyInputSchema, output: z.object({ item: HealthResultSchema }) },
  openPath: { input: z.object({ path: z.string().min(1) }), output: OkOutputSchema },
  openExternal: { input: z.object({ url: z.string().url() }), output: OkOutputSchema },
  supportBundle: { input: EmptyInputSchema, output: z.object({ path: z.string() }) },
  checkUpdate: {
    input: EmptyInputSchema,
    output: z.object({
      item: z.object({ available: z.boolean(), version: z.string().nullable() }),
    }),
  },
  restart: { input: EmptyInputSchema, output: OkOutputSchema },
  scanFolder: {
    input: z.object({ path: z.string().min(1) }),
    output: z.object({ item: ScanResultSchema }),
  },
  /** §16 Advanced: "database maintenance (backup / compact)" — M1's
   * db/backup.ts already has the mechanism; not in §17.1's original code
   * block. See the M2 plan/PROGRESS.md. */
  backupDb: { input: EmptyInputSchema, output: z.object({ path: z.string() }) },
  compactDb: { input: EmptyInputSchema, output: OkOutputSchema },
  /** §16 Privacy & Data: "open the data folder." Same origin as above. */
  openDataFolder: { input: EmptyInputSchema, output: OkOutputSchema },
};
