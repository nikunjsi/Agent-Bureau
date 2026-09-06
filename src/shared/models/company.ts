import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { jsonColumnSchema } from './json';
import { FloorLayoutSchema, emptyFloorLayout } from '../floor/layout';

/**
 * `companies.floor_layout` was `z.record(z.unknown())` through M1–M7
 * session 1, with a comment saying the shape was owned by the floor layout
 * generator. M7 session 2 built that generator, so the shape is real now
 * and lives in `src/shared/floor/layout.ts` — see §5.1 and §13.3.
 *
 * A company created before the generator has run holds an EMPTY layout
 * (well-formed, zero rooms) rather than `{}`, so no reader has to
 * special-case the pre-generation state.
 */
export { FloorLayoutSchema, emptyFloorLayout };

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

/**
 * The same company, as it crosses IPC — see `DepartmentWireSchema` for
 * the full reasoning. `floor_layout` and `settings` are both JSON columns,
 * so the row schema cannot validate an already-parsed `Company`, and the
 * router validates every handler's output.
 */
export const CompanyWireSchema = CompanySchema.extend({
  floor_layout: FloorLayoutSchema,
  settings: CompanySettingsBlobSchema,
});
export type CompanyWire = z.infer<typeof CompanyWireSchema>;

export const NewCompanyInputSchema = z.object({
  name: z.string().min(1),
  home_path: z.string().min(1),
  /**
   * Optional rather than defaulted: an empty layout has to name the
   * company it belongs to, and the id does not exist until `insertCompany`
   * mints it. So the repository fills this in with `emptyFloorLayout(id)`
   * when it is absent, and a caller that already has a generated layout
   * can pass one.
   */
  floor_layout: FloorLayoutSchema.optional(),
  settings: CompanySettingsBlobSchema.default({}),
});
export type NewCompanyInput = z.input<typeof NewCompanyInputSchema>;
