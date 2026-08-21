import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { jsonColumnSchema, nullableJsonColumnSchema } from './json';

const RoomRectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** `departments.theme` — floor tile, wall tile, props. Owned by M12/§13. */
const DepartmentThemeSchema = z.object({
  floor: z.string().optional(),
  wall: z.string().optional(),
  props: z.array(z.string()).optional(),
});

export const DepartmentSchema = z.object({
  id: IdSchema,
  key: z.string().min(1),
  name: z.string().min(1),
  pack_id: z.string().nullable(),
  room_rect: jsonColumnSchema(RoomRectSchema),
  theme: nullableJsonColumnSchema(DepartmentThemeSchema),
  enabled: z.coerce.boolean(),
  // Not in §5.1's own row listing for this table, but §5.0's blanket rule
  // applies (mutable via `enabled`, not events/a join table) — see
  // PROGRESS.md's M1 entry for the full reasoning.
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Department = z.infer<typeof DepartmentSchema>;

export const NewDepartmentInputSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  pack_id: z.string().nullable().default(null),
  room_rect: RoomRectSchema,
  theme: DepartmentThemeSchema.nullable().default(null),
  enabled: z.boolean().default(true),
});
export type NewDepartmentInput = z.infer<typeof NewDepartmentInputSchema>;
