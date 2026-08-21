import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { jsonColumnSchema } from './json';

/** `companies.floor_layout` — room grid, desk coordinates. Shape owned by
 * the floor layout generator (M7/M12); kept loose here on purpose. */
const FloorLayoutSchema = z.record(z.unknown());

/** `companies.settings` is a JSON escape hatch distinct from the `settings`
 * table (§16.1) — currently unused by anything in M1; kept loose. */
const CompanySettingsBlobSchema = z.record(z.unknown());

export const CompanySchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  home_path: z.string().min(1),
  director_employee_id: IdSchema.nullable(),
  floor_layout: jsonColumnSchema(FloorLayoutSchema),
  settings: jsonColumnSchema(CompanySettingsBlobSchema),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Company = z.infer<typeof CompanySchema>;

export const NewCompanyInputSchema = z.object({
  name: z.string().min(1),
  home_path: z.string().min(1),
  floor_layout: FloorLayoutSchema.default({}),
  settings: CompanySettingsBlobSchema.default({}),
});
export type NewCompanyInput = z.infer<typeof NewCompanyInputSchema>;
