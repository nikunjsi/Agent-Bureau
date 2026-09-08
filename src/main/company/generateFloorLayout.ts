import {
  BREAK_AREA_SIZE,
  CORRIDOR_TILES,
  DESKS_PER_ROW,
  DIRECTOR_OFFICE,
  ENTRANCE_SIZE,
  FLOOR_EXPAND_STEP_TILES,
  FLOOR_MAX_HEIGHT_TILES,
  FLOOR_MIN_HEIGHT_TILES,
  FLOOR_WIDTH_TILES,
  MEETING_ROOM_SIZE,
  ROOM_WALL_TILES,
  type Desk,
  type DroppedPin,
  type FloorLayout,
  type Prop,
  type Room,
  type TilePoint,
  type TileRect,
} from '../../shared/floor/layout';

/**
 * §13.3's eight steps, in order, as a **pure function**. No DB, no I/O, no
 * clock, no randomness.
 *
 * ## Determinism, and why it is stronger than the spec asks for
 *
 * §13.3 says "deterministic, seeded by company id so the layout is
 * stable". A seeded PRNG would satisfy that. This does something stricter:
 * there is no RNG at all, so the same inputs produce a byte-identical
 * layout by CONSTRUCTION rather than by two runs happening to agree on a
 * seed. Every ordering decision is made explicitly (departments by key,
 * employees by id) instead of inherited from a caller's array order or
 * SQLite's row order. The company id still enters the output — a layout
 * records which company it describes — and is the tiebreaker anywhere a
 * choice is genuinely arbitrary.
 *
 * ## Why `previousLayout` is an input
 *
 * §13.3 also promises "the user can drag employees between desks; the
 * layout persists". Those two sentences cannot both hold if the generator
 * is a function of departments and employees alone: step 3 sizes rooms by
 * employee count, so the next hire re-packs and silently erases every
 * manual placement.
 *
 * Purity was never threatened by taking more inputs — only by hidden
 * state. So pins come in as data, read from the previous layout itself
 * (each desk carries `pinned`), which keeps one source of truth and no
 * extra table. The alternative — generate, then patch placements back on
 * afterwards — would mean the persisted layout is not what the generator
 * produced, putting layout logic in two places.
 */

export interface DepartmentForLayout {
  readonly key: string;
  readonly name: string;
  readonly preferredW: number;
  readonly preferredH: number;
  readonly props: readonly string[];
}

export interface EmployeeForLayout {
  readonly id: string;
  /** Which department's room they sit in. Directors sit in the corner
   * office (§13.5) and are passed with `departmentKey: null`. */
  readonly departmentKey: string | null;
  readonly isDirector: boolean;
}

export interface GenerateFloorLayoutInput {
  readonly companyId: string;
  readonly departments: readonly DepartmentForLayout[];
  /** Active employees only — an archived one has no desk (§6.8). */
  readonly employees: readonly EmployeeForLayout[];
  readonly previousLayout: FloorLayout | null;
}

export interface GenerateFloorLayoutResult {
  readonly layout: FloorLayout;
  /** Manual placements this generation could not honour. Never empty
   * silently — `persistFloorLayout` reports them. */
  readonly droppedPins: DroppedPin[];
}

export class FloorTooSmallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FloorTooSmallError';
  }
}

/** Step 3: `max(preferred_size, ceil(employees / 4) desks + walking space)`. */
export function roomSizeFor(
  department: DepartmentForLayout,
  employeeCount: number,
): { w: number; h: number } {
  const deskRows = Math.max(1, Math.ceil(employeeCount / DESKS_PER_ROW));
  // Walking space: a wall ring plus a 1-tile aisle between desk rows
  // (step 6). A row of desks is 1 tile deep, and each row after the first
  // needs its own aisle in front of it.
  const neededH = 2 * ROOM_WALL_TILES + deskRows * 2;
  const neededW = 2 * ROOM_WALL_TILES + DESKS_PER_ROW;
  return {
    w: Math.max(department.preferredW, neededW),
    h: Math.max(department.preferredH, neededH),
  };
}

/** Step 6: desk slots in a grid, leaving the wall ring and a 1-tile aisle. */
function deskSlotsFor(rect: TileRect): TilePoint[] {
  const slots: TilePoint[] = [];
  const innerW = rect.w - 2 * ROOM_WALL_TILES;
  const innerH = rect.h - 2 * ROOM_WALL_TILES;
  if (innerW <= 0 || innerH <= 0) return slots;

  const perRow = Math.min(DESKS_PER_ROW, innerW);
  // Step 2 downward: a desk row, then an aisle. Row 0 sits directly below
  // the wall; row N sits 2N tiles further down.
  for (let row = 0; row * 2 < innerH; row += 1) {
    const y = rect.y + ROOM_WALL_TILES + row * 2;
    for (let col = 0; col < perRow; col += 1) {
      slots.push({ x: rect.x + ROOM_WALL_TILES + col, y });
    }
  }
  return slots;
}

/** Step 7: props at fixed anchors — the room's inner corners, clockwise
 * from top-left, so the same theme always lands in the same places. */
function propsFor(rect: TileRect, propKeys: readonly string[]): Prop[] {
  const inner = {
    left: rect.x + ROOM_WALL_TILES,
    right: rect.x + rect.w - ROOM_WALL_TILES - 1,
    top: rect.y + ROOM_WALL_TILES,
    bottom: rect.y + rect.h - ROOM_WALL_TILES - 1,
  };
  const anchors: TilePoint[] = [
    { x: inner.right, y: inner.top },
    { x: inner.right, y: inner.bottom },
    { x: inner.left, y: inner.bottom },
    { x: inner.left, y: inner.top },
  ];
  return propKeys
    .slice(0, anchors.length)
    .map((key, index) => ({ key, x: anchors[index]!.x, y: anchors[index]!.y }));
}

/** A door on the room's bottom wall, or its top wall for a room at y=0.
 * Deterministic: always the leftmost inner column. */
function doorFor(rect: TileRect): TilePoint {
  const x = rect.x + ROOM_WALL_TILES;
  return rect.y === 0 ? { x, y: rect.y + rect.h - 1 } : { x, y: rect.y };
}

interface Placement {
  readonly department: DepartmentForLayout;
  readonly rect: TileRect;
}

/**
 * Steps 4 and 5: pack left-to-right, top-to-bottom with 1-tile corridors;
 * expand downward and re-pack if the floor is full. Width never grows,
 * which is exactly what makes §6.7 check 8 answerable.
 */
function packRooms(
  departments: readonly DepartmentForLayout[],
  sizes: ReadonlyMap<string, { w: number; h: number }>,
  reservedBottom: number,
  floorHeight: number,
): Placement[] | null {
  const placements: Placement[] = [];
  let cursorX = CORRIDOR_TILES;
  let rowY = reservedBottom + CORRIDOR_TILES;
  let rowHeight = 0;

  for (const department of departments) {
    const size = sizes.get(department.key)!;
    if (cursorX + size.w + CORRIDOR_TILES > FLOOR_WIDTH_TILES) {
      // Next row down.
      cursorX = CORRIDOR_TILES;
      rowY += rowHeight + CORRIDOR_TILES;
      rowHeight = 0;
    }
    if (rowY + size.h + CORRIDOR_TILES > floorHeight) return null; // full — caller expands
    placements.push({ department, rect: { x: cursorX, y: rowY, w: size.w, h: size.h } });
    cursorX += size.w + CORRIDOR_TILES;
    rowHeight = Math.max(rowHeight, size.h);
  }

  return placements;
}

export function generateFloorLayout(input: GenerateFloorLayoutInput): GenerateFloorLayoutResult {
  // Every ordering decision made here, not inherited from the caller.
  const departments = [...input.departments].sort((a, b) => a.key.localeCompare(b.key));
  const employees = [...input.employees].sort((a, b) => a.id.localeCompare(b.id));

  const byDepartment = new Map<string, EmployeeForLayout[]>();
  for (const department of departments) byDepartment.set(department.key, []);
  for (const employee of employees) {
    if (employee.isDirector || employee.departmentKey === null) continue;
    byDepartment.get(employee.departmentKey)?.push(employee);
  }

  // --- steps 1 and 2: the reserved spaces -------------------------------
  const meetingX = Math.floor((FLOOR_WIDTH_TILES - MEETING_ROOM_SIZE.w) / 2);
  const directorRect: TileRect = { ...DIRECTOR_OFFICE };
  const meetingRect: TileRect = {
    x: meetingX,
    y: 0,
    w: MEETING_ROOM_SIZE.w,
    h: MEETING_ROOM_SIZE.h,
  };
  const breakRect: TileRect = {
    x: FLOOR_WIDTH_TILES - BREAK_AREA_SIZE.w - CORRIDOR_TILES,
    y: 0,
    w: BREAK_AREA_SIZE.w,
    h: BREAK_AREA_SIZE.h,
  };
  const entranceRect: TileRect = {
    x: DIRECTOR_OFFICE.w + CORRIDOR_TILES,
    y: 0,
    w: ENTRANCE_SIZE.w,
    h: ENTRANCE_SIZE.h,
  };
  const reservedBottom = Math.max(
    directorRect.y + directorRect.h,
    meetingRect.y + meetingRect.h,
    breakRect.y + breakRect.h,
    entranceRect.y + entranceRect.h,
  );

  // --- step 3: size each department's room ------------------------------
  const sizes = new Map<string, { w: number; h: number }>();
  for (const department of departments) {
    const size = roomSizeFor(department, byDepartment.get(department.key)?.length ?? 0);
    if (size.w + 2 * CORRIDOR_TILES > FLOOR_WIDTH_TILES) {
      // The floor expands downward only (§13.3 step 5), so a room too WIDE
      // can never be placed no matter how far it grows. §6.7 check 8
      // rejects this at pack-validation time; reaching it here means a
      // pack got installed before that check existed.
      throw new FloorTooSmallError(
        `department "${department.key}" needs ${size.w} tiles of width, but the floor is only ` +
          `${FLOOR_WIDTH_TILES} wide and expands downward only.`,
      );
    }
    sizes.set(department.key, size);
  }

  // --- steps 4 and 5: pack, expanding downward until everything fits -----
  let floorHeight = FLOOR_MIN_HEIGHT_TILES;
  let placements = packRooms(departments, sizes, reservedBottom, floorHeight);
  while (placements === null) {
    floorHeight += FLOOR_EXPAND_STEP_TILES;
    if (floorHeight > FLOOR_MAX_HEIGHT_TILES) {
      throw new FloorTooSmallError(
        `the floor would have to exceed ${FLOOR_MAX_HEIGHT_TILES} tiles tall to hold ${departments.length} departments.`,
      );
    }
    placements = packRooms(departments, sizes, reservedBottom, floorHeight);
  }

  // --- pins ------------------------------------------------------------
  const pinnedByEmployee = new Map<string, TilePoint>();
  for (const room of input.previousLayout?.rooms ?? []) {
    for (const desk of room.desks) {
      if (desk.pinned && desk.employeeId !== null) {
        pinnedByEmployee.set(desk.employeeId, { x: desk.x, y: desk.y });
      }
    }
  }
  const droppedPins: DroppedPin[] = [];

  /**
   * Seats one room's occupants into its generated slots.
   *
   * Pinned employees are seated FIRST, in id order. That ordering is
   * load-bearing: a manual placement must never lose its slot to someone
   * who never expressed an opinion about where they sit.
   */
  function seat(rect: TileRect, occupants: readonly EmployeeForLayout[]): Desk[] {
    const slots = deskSlotsFor(rect);
    const slotKey = (p: TilePoint): string => `${p.x},${p.y}`;
    const free = new Set(slots.map(slotKey));
    const assigned = new Map<string, string>(); // slotKey -> employeeId
    const pinnedSlots = new Set<string>();

    const pinned = occupants.filter((e) => pinnedByEmployee.has(e.id));
    const unpinned = occupants.filter((e) => !pinnedByEmployee.has(e.id));

    for (const employee of pinned) {
      const pin = pinnedByEmployee.get(employee.id)!;
      const key = slotKey(pin);
      if (free.has(key)) {
        free.delete(key);
        assigned.set(key, employee.id);
        pinnedSlots.add(key);
        continue;
      }
      // The pin cannot be honoured. Drop it and say so — growing the room
      // to fit would let one drag permanently distort the floor, and
      // relocating someone silently is the failure this exists to avoid.
      const fallback = [...free].sort()[0];
      const reason: DroppedPin['reason'] = slots.some((s) => slotKey(s) === key)
        ? 'slot_taken'
        : 'room_no_longer_contains_desk';
      if (fallback !== undefined) {
        free.delete(fallback);
        assigned.set(fallback, employee.id);
        const [fx, fy] = fallback.split(',').map(Number);
        droppedPins.push({ employeeId: employee.id, from: pin, to: { x: fx!, y: fy! }, reason });
      }
    }

    for (const employee of unpinned) {
      // `slots` order, not set order — lowest-index unclaimed slot.
      const next = slots.find((s) => free.has(slotKey(s)));
      if (next === undefined) break;
      free.delete(slotKey(next));
      assigned.set(slotKey(next), employee.id);
    }

    return slots.map((slot) => {
      const key = slotKey(slot);
      const employeeId = assigned.get(key) ?? null;
      return { x: slot.x, y: slot.y, employeeId, pinned: pinnedSlots.has(key) };
    });
  }

  const director = employees.find((e) => e.isDirector);

  const rooms: Room[] = [
    {
      kind: 'director',
      departmentKey: null,
      name: "Director's office",
      rect: directorRect,
      door: doorFor(directorRect),
      // §13.5: the Director sits in the corner office. One desk, and it is
      // never pinnable — there is nowhere else for them to go.
      desks: [
        {
          x: directorRect.x + ROOM_WALL_TILES,
          y: directorRect.y + ROOM_WALL_TILES,
          employeeId: director?.id ?? null,
          pinned: false,
        },
      ],
      props: propsFor(directorRect, ['desk_large', 'bookshelf', 'plant', 'window']),
    },
    {
      kind: 'entrance',
      departmentKey: null,
      name: 'Entrance',
      rect: entranceRect,
      door: doorFor(entranceRect),
      desks: [],
      props: propsFor(entranceRect, ['door_front']),
    },
    {
      kind: 'meeting',
      departmentKey: null,
      name: 'Meeting room',
      rect: meetingRect,
      door: doorFor(meetingRect),
      desks: [],
      props: propsFor(meetingRect, ['meeting_table', 'whiteboard']),
    },
    {
      kind: 'break',
      departmentKey: null,
      name: 'Break area',
      rect: breakRect,
      door: doorFor(breakRect),
      desks: [],
      props: propsFor(breakRect, ['coffee_machine', 'plant']),
    },
    ...placements.map<Room>(({ department, rect }) => ({
      kind: 'department' as const,
      departmentKey: department.key,
      name: department.name,
      rect,
      door: doorFor(rect),
      desks: seat(rect, byDepartment.get(department.key) ?? []),
      props: propsFor(rect, department.props),
    })),
  ];

  return {
    layout: {
      version: 1,
      companyId: input.companyId,
      grid: { w: FLOOR_WIDTH_TILES, h: floorHeight },
      rooms,
    },
    droppedPins,
  };
}
