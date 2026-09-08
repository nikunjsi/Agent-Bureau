import { z } from 'zod';

/**
 * §13.3's output, as a real shape.
 *
 * `companies.floor_layout` was `z.record(z.unknown())` until M7 session 2,
 * with its own comment saying "Shape owned by the floor layout generator
 * (M7/M12); kept loose here on purpose." This is that moment: M12 renders
 * from this and should not have to guess, and §5.1 documents it.
 *
 * Tile coordinates throughout (§13.2: 32x32px logical tiles, integer
 * scales only). Nothing here is pixels.
 */

// --- §13.2's dimensions -------------------------------------------------

/** §13.2: "Default 40x24 tiles, expanding as departments are added." */
export const FLOOR_WIDTH_TILES = 40;
export const FLOOR_MIN_HEIGHT_TILES = 24;

/**
 * §13.3 step 5 expands the map **downward** and re-packs. Width never
 * grows — which is what makes §6.7 check 8 answerable: a room wider than
 * the usable floor can never be placed, no matter how far the floor
 * grows.
 */
export const FLOOR_EXPAND_STEP_TILES = 8;
/** A guard against a pathological pack, not a product limit. */
export const FLOOR_MAX_HEIGHT_TILES = 200;

/** §13.3 step 1: "the Director's corner office (top-left, 6x5)". */
export const DIRECTOR_OFFICE = { x: 0, y: 0, w: 6, h: 5 } as const;
/** §13.3 step 2: "meeting room (centre-top, 8x5), break area, entrance". */
export const MEETING_ROOM_SIZE = { w: 8, h: 5 } as const;
export const BREAK_AREA_SIZE = { w: 6, h: 4 } as const;
export const ENTRANCE_SIZE = { w: 4, h: 3 } as const;

/** §13.3 step 4: "1-tile corridors between". */
export const CORRIDOR_TILES = 1;
/** §13.3 step 6: "desks in a grid inside each room, leaving a 1-tile aisle". */
export const ROOM_WALL_TILES = 1;
/** §13.3 step 3: "ceil(employees / 4) desks + walking space". */
export const DESKS_PER_ROW = 4;

/**
 * The widest room the floor can ever hold. §6.7 check 8's real question,
 * now that the generator exists to answer it.
 */
export const MAX_ROOM_WIDTH_TILES = FLOOR_WIDTH_TILES - 2 * CORRIDOR_TILES;

// --- the shape ----------------------------------------------------------

export const TileRectSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })
  .strict();
export type TileRect = z.infer<typeof TileRectSchema>;

export const TilePointSchema = z
  .object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() })
  .strict();
export type TilePoint = z.infer<typeof TilePointSchema>;

/**
 * `department` rooms come from packs; the other four are §13.3's reserved
 * spaces and exist on every floor regardless of which packs are installed.
 */
export const RoomKindSchema = z.enum(['director', 'meeting', 'break', 'entrance', 'department']);
export type RoomKind = z.infer<typeof RoomKindSchema>;

export const DeskSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    /** Null for a generated-but-unoccupied desk. */
    employeeId: z.string().nullable(),
    /**
     * §13.3: "The user can drag employees between desks; the layout
     * persists." A pinned desk is a placement a PERSON chose, and it is
     * the reason the generator takes the previous layout as an input
     * rather than being a function of departments and employees alone —
     * without this flag, the next hire's re-pack would silently undo
     * every manual placement.
     */
    pinned: z.boolean(),
  })
  .strict();
export type Desk = z.infer<typeof DeskSchema>;

export const PropSchema = z
  .object({
    key: z.string().min(1),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  })
  .strict();
export type Prop = z.infer<typeof PropSchema>;

export const RoomSchema = z
  .object({
    kind: RoomKindSchema,
    /** The department key for `kind: 'department'`; null for the rest. */
    departmentKey: z.string().nullable(),
    name: z.string().min(1),
    rect: TileRectSchema,
    /** §13.3 step 1: rooms have a door. Always on the room's boundary. */
    door: TilePointSchema,
    desks: z.array(DeskSchema),
    props: z.array(PropSchema),
  })
  .strict();
export type Room = z.infer<typeof RoomSchema>;

export const FloorLayoutSchema = z
  .object({
    /** Bumped when this shape changes incompatibly, so M12 can refuse a
     * layout it does not understand rather than mis-render one. */
    version: z.literal(1),
    /** The company id it was generated from — §13.3's "seeded by company
     * id". Recorded so a layout can be checked against the company it
     * claims to describe. */
    companyId: z.string().min(1),
    grid: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }).strict(),
    rooms: z.array(RoomSchema),
  })
  .strict();
export type FloorLayout = z.infer<typeof FloorLayoutSchema>;

/**
 * An empty floor — what `companies.floor_layout` holds before the
 * generator has ever run. Deliberately NOT `{}`: a caller reading a layout
 * should get a well-formed one with no rooms, not a shape it has to
 * special-case.
 */
export function emptyFloorLayout(companyId: string): FloorLayout {
  return {
    version: 1,
    companyId,
    grid: { w: FLOOR_WIDTH_TILES, h: FLOOR_MIN_HEIGHT_TILES },
    rooms: [],
  };
}

/**
 * A manual placement the generator could not honour — the room shrank,
 * moved, or two pins landed on the same slot after a re-pack.
 *
 * Reported rather than silently applied: relocating someone the user
 * deliberately placed, without saying so, is the failure this whole
 * mechanism exists to avoid.
 */
export interface DroppedPin {
  readonly employeeId: string;
  readonly from: TilePoint;
  readonly to: TilePoint;
  readonly reason: 'room_no_longer_contains_desk' | 'slot_taken';
}
