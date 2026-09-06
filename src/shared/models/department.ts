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
  /**
   * What the GENERATOR allocated (§13.3), not what the pack asked for —
   * see `preferred_w`/`preferred_h` below. Written by `installPack` as the
   * preferred dimensions at origin (0,0) and overwritten with the real
   * placement the first time the floor is generated.
   */
  room_rect: jsonColumnSchema(RoomRectSchema),
  /**
   * What the PACK asks for (§6.4 `room.preferred_size`), added at M7
   * session 2 (migration 0007). §13.3 step 3 needs it on every run, and
   * before 0007 the generator destroyed it by overwriting `room_rect`.
   */
  preferred_w: z.number().int().positive(),
  preferred_h: z.number().int().positive(),
  theme: nullableJsonColumnSchema(DepartmentThemeSchema),
  enabled: z.coerce.boolean(),
  // Not in §5.1's own row listing for this table, but §5.0's blanket rule
  // applies (mutable via `enabled`, not events/a join table) — see
  // PROGRESS.md's M1 entry for the full reasoning.
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Department = z.infer<typeof DepartmentSchema>;

/**
 * The same department, as it crosses IPC.
 *
 * `DepartmentSchema` is a **row** schema: its JSON columns are
 * `jsonColumnSchema(...)`, which parses a raw TEXT column into structure.
 * Feeding it an already-parsed `Department` fails, because `room_rect` is
 * then an object where the schema expects the string it came from.
 *
 * That matters because the IPC router validates every handler's output
 * (`router.ts`), so a method declaring `DepartmentSchema` as its output
 * could only ever return raw rows — handing the renderer JSON strings to
 * parse itself, which is exactly what the model layer exists to prevent.
 * Found at M7 session 2, when `company.listDepartments` stopped being a
 * stub and became the first method to actually return one.
 *
 * Derived from the row schema rather than restated, so a new column cannot
 * appear in one and not the other.
 */
export const DepartmentWireSchema = DepartmentSchema.extend({
  room_rect: RoomRectSchema,
  theme: DepartmentThemeSchema.nullable(),
});
export type DepartmentWire = z.infer<typeof DepartmentWireSchema>;

export const NewDepartmentInputSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  pack_id: z.string().nullable().default(null),
  room_rect: RoomRectSchema,
  preferred_w: z.number().int().positive().default(8),
  preferred_h: z.number().int().positive().default(6),
  theme: DepartmentThemeSchema.nullable().default(null),
  enabled: z.boolean().default(true),
});
export type NewDepartmentInput = z.input<typeof NewDepartmentInputSchema>;
