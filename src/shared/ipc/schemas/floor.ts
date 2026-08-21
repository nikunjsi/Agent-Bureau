import { z } from 'zod';
import { IdSchema } from '../../models/ids';
import { EmptyInputSchema, OkOutputSchema } from './common';

/** Room grid, desk coordinates — same deliberately loose shape as
 * `companies.floor_layout` (src/shared/models/company.ts). Real structure
 * belongs to M7 (pack rooms)/M12 (the Phaser scene). */
const FloorLayoutSchema = z.record(z.unknown());

export const Floor = {
  getLayout: { input: EmptyInputSchema, output: z.object({ item: FloorLayoutSchema }) },
  moveDesk: {
    input: z.object({ employeeId: IdSchema, x: z.number().int(), y: z.number().int() }),
    output: OkOutputSchema,
  },
  resetLayout: { input: EmptyInputSchema, output: OkOutputSchema },
};
