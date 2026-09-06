import { describe, expect, it } from 'vitest';
import {
  generateFloorLayout,
  roomSizeFor,
  FloorTooSmallError,
  type DepartmentForLayout,
  type EmployeeForLayout,
} from '../../../src/main/company/generateFloorLayout';
import {
  FLOOR_MIN_HEIGHT_TILES,
  FLOOR_WIDTH_TILES,
  FloorLayoutSchema,
  type FloorLayout,
} from '../../../src/shared/floor/layout';

/**
 * §13.3's generator. Pure, so these drive the production function directly
 * with no fixture standing in for it — the assertion path is the shipping
 * code.
 */

function dept(key: string, over: Partial<DepartmentForLayout> = {}): DepartmentForLayout {
  return { key, name: key, preferredW: 12, preferredH: 8, props: ['whiteboard', 'plant'], ...over };
}

function emp(id: string, departmentKey: string | null, isDirector = false): EmployeeForLayout {
  return { id, departmentKey, isDirector };
}

function gen(
  departments: DepartmentForLayout[],
  employees: EmployeeForLayout[],
  previousLayout: FloorLayout | null = null,
  companyId = 'co-1',
) {
  return generateFloorLayout({ companyId, departments, employees, previousLayout });
}

function deskOf(layout: FloorLayout, employeeId: string) {
  for (const room of layout.rooms) {
    const desk = room.desks.find((d) => d.employeeId === employeeId);
    if (desk) return desk;
  }
  return undefined;
}

function roomFor(layout: FloorLayout, key: string) {
  return layout.rooms.find((r) => r.departmentKey === key)!;
}

describe('§13.3 steps 1 and 2 — the reserved spaces', () => {
  it('reserves the Director’s corner office at top-left, 6x5, with a door', () => {
    const { layout } = gen([dept('engineering')], []);
    const office = layout.rooms.find((r) => r.kind === 'director')!;
    expect(office.rect).toEqual({ x: 0, y: 0, w: 6, h: 5 });
    // The door is on the room's own boundary, not floating inside it.
    const onBoundary =
      office.door.x === office.rect.x ||
      office.door.x === office.rect.x + office.rect.w - 1 ||
      office.door.y === office.rect.y ||
      office.door.y === office.rect.y + office.rect.h - 1;
    expect(onBoundary).toBe(true);
  });

  it('reserves a meeting room, break area and entrance on every floor', () => {
    const { layout } = gen([], []);
    expect(layout.rooms.map((r) => r.kind).sort()).toEqual(['break', 'director', 'entrance', 'meeting']);
  });

  it('seats the Director in the corner office, not a department room', () => {
    const { layout } = gen([dept('engineering')], [emp('dir-1', null, true)]);
    const office = layout.rooms.find((r) => r.kind === 'director')!;
    expect(office.desks[0]!.employeeId).toBe('dir-1');
    expect(roomFor(layout, 'engineering').desks.every((d) => d.employeeId === null)).toBe(true);
  });
});

describe('§13.3 step 3 — room sizing', () => {
  it('honours preferred_size when it is larger than the desks need', () => {
    expect(roomSizeFor(dept('x', { preferredW: 20, preferredH: 14 }), 1)).toEqual({ w: 20, h: 14 });
  });

  it('grows past preferred_size when there are more employees than it fits', () => {
    const small = dept('x', { preferredW: 6, preferredH: 4 });
    const forOne = roomSizeFor(small, 1);
    const forTwelve = roomSizeFor(small, 12);
    expect(forTwelve.h).toBeGreaterThan(forOne.h);
  });

  it('sizes by ceil(employees / 4) desk rows', () => {
    const d = dept('x', { preferredW: 4, preferredH: 2 });
    // 4 employees is one row; 5 needs a second.
    expect(roomSizeFor(d, 5).h).toBeGreaterThan(roomSizeFor(d, 4).h);
    expect(roomSizeFor(d, 4).h).toEqual(roomSizeFor(d, 1).h);
  });
});

describe('§13.3 steps 4 and 5 — packing and downward expansion', () => {
  it('packs rooms without overlapping, and inside the grid', () => {
    const departments = ['a', 'b', 'c', 'd', 'e'].map((k) => dept(k));
    const { layout } = gen(departments, []);

    for (const room of layout.rooms) {
      expect(room.rect.x + room.rect.w).toBeLessThanOrEqual(layout.grid.w);
      expect(room.rect.y + room.rect.h).toBeLessThanOrEqual(layout.grid.h);
    }
    for (let i = 0; i < layout.rooms.length; i += 1) {
      for (let j = i + 1; j < layout.rooms.length; j += 1) {
        const a = layout.rooms[i]!.rect;
        const b = layout.rooms[j]!.rect;
        const disjoint =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(disjoint, `${layout.rooms[i]!.name} overlaps ${layout.rooms[j]!.name}`).toBe(true);
      }
    }
  });

  it('expands the floor DOWNWARD, never wider', () => {
    const many = Array.from({ length: 12 }, (_, i) => dept(`d${String(i).padStart(2, '0')}`));
    const { layout } = gen(many, []);
    expect(layout.grid.h).toBeGreaterThan(FLOOR_MIN_HEIGHT_TILES);
    expect(layout.grid.w).toBe(FLOOR_WIDTH_TILES);
  });

  it('refuses a room wider than the floor — the case downward expansion can never fix', () => {
    expect(() => gen([dept('huge', { preferredW: 60 })], [])).toThrow(FloorTooSmallError);
  });
});

describe('§13.3 step 6 — desks', () => {
  it('places desks inside the room, off the walls', () => {
    const { layout } = gen([dept('engineering')], [emp('e1', 'engineering')]);
    const room = roomFor(layout, 'engineering');
    for (const desk of room.desks) {
      expect(desk.x).toBeGreaterThan(room.rect.x);
      expect(desk.x).toBeLessThan(room.rect.x + room.rect.w - 1);
      expect(desk.y).toBeGreaterThan(room.rect.y);
      expect(desk.y).toBeLessThan(room.rect.y + room.rect.h - 1);
    }
  });

  it('gives every employee in a department a distinct desk', () => {
    const employees = ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => emp(id, 'engineering'));
    const { layout } = gen([dept('engineering')], employees);
    const seated = roomFor(layout, 'engineering')
      .desks.map((d) => d.employeeId)
      .filter((id): id is string => id !== null);
    expect(seated.sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });
});

describe('the layout is a valid FloorLayout', () => {
  it('parses against the real schema, which is what M12 will read', () => {
    const { layout } = gen([dept('engineering'), dept('operations')], [emp('e1', 'engineering')]);
    expect(() => FloorLayoutSchema.parse(layout)).not.toThrow();
  });
});

describe('determinism — the milestone gate’s own property', () => {
  it('produces a byte-identical layout for the same inputs', () => {
    const departments = [dept('engineering'), dept('operations')];
    const employees = [emp('e1', 'engineering'), emp('e2', 'operations'), emp('d1', null, true)];
    const a = gen(departments, employees).layout;
    const b = gen(departments, employees).layout;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not depend on the ORDER the caller passes departments or employees in', () => {
    // The generator sorts its own inputs. Without that, a change to a
    // SQL ORDER BY three layers away would silently move everyone's desk.
    const forward = gen(
      [dept('engineering'), dept('operations')],
      [emp('e1', 'engineering'), emp('e2', 'operations')],
    ).layout;
    const reversed = gen(
      [dept('operations'), dept('engineering')],
      [emp('e2', 'operations'), emp('e1', 'engineering')],
    ).layout;
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it('records the company it was generated for', () => {
    expect(gen([dept('engineering')], [], null, 'co-77').layout.companyId).toBe('co-77');
  });
});

describe('manual desk placements survive a re-pack (§13.3’s "the layout persists")', () => {
  function pin(layout: FloorLayout, employeeId: string): FloorLayout {
    const copy = FloorLayoutSchema.parse(JSON.parse(JSON.stringify(layout)));
    for (const room of copy.rooms) {
      for (const desk of room.desks) {
        if (desk.employeeId === employeeId) desk.pinned = true;
      }
    }
    return copy;
  }

  it('keeps a pinned desk across a hire that does not disturb its room', () => {
    const departments = [dept('engineering'), dept('operations')];
    const first = gen(departments, [emp('e1', 'engineering')]).layout;
    // Move e1 to a different slot in its own room, and pin it.
    const room = roomFor(first, 'engineering');
    const target = room.desks.find((d) => d.employeeId === null)!;
    const moved = FloorLayoutSchema.parse(JSON.parse(JSON.stringify(first)));
    const movedRoom = roomFor(moved, 'engineering');
    movedRoom.desks.find((d) => d.employeeId === 'e1')!.employeeId = null;
    const movedDesk = movedRoom.desks.find((d) => d.x === target.x && d.y === target.y)!;
    movedDesk.employeeId = 'e1';
    movedDesk.pinned = true;

    // Hire into the OTHER department — engineering's geometry is untouched.
    const after = gen(departments, [emp('e1', 'engineering'), emp('o1', 'operations')], moved);

    expect(after.droppedPins).toEqual([]);
    expect(deskOf(after.layout, 'e1')).toMatchObject({ x: target.x, y: target.y, pinned: true });
  });

  it('a pinned employee never loses a slot to an unpinned one', () => {
    const departments = [dept('engineering')];
    const base = gen(departments, [emp('e2', 'engineering')]).layout;
    // Pin e2 onto the FIRST slot — the one an unpinned employee would
    // otherwise take, since placement fills lowest-index first and "e1"
    // sorts before "e2".
    const room = roomFor(base, 'engineering');
    const firstSlot = room.desks[0]!;
    const pinned = FloorLayoutSchema.parse(JSON.parse(JSON.stringify(base)));
    const pinnedRoom = roomFor(pinned, 'engineering');
    for (const desk of pinnedRoom.desks) desk.employeeId = null;
    pinnedRoom.desks.find((d) => d.x === firstSlot.x && d.y === firstSlot.y)!.employeeId = 'e2';
    pinnedRoom.desks.find((d) => d.x === firstSlot.x && d.y === firstSlot.y)!.pinned = true;

    const after = gen(departments, [emp('e1', 'engineering'), emp('e2', 'engineering')], pinned);

    expect(after.droppedPins).toEqual([]);
    expect(deskOf(after.layout, 'e2')).toMatchObject({ x: firstSlot.x, y: firstSlot.y });
    expect(deskOf(after.layout, 'e1')).not.toMatchObject({ x: firstSlot.x, y: firstSlot.y });
  });

  it('DROPS a pin whose desk no longer exists, reports it, and does not relocate silently', () => {
    // A pin far outside any room this generation produces — the shape of
    // what happens when a room shrinks or moves under a re-pack.
    const departments = [dept('engineering')];
    const base = gen(departments, [emp('e1', 'engineering')]).layout;
    const stale = FloorLayoutSchema.parse(JSON.parse(JSON.stringify(base)));
    const staleRoom = roomFor(stale, 'engineering');
    const staleDesk = staleRoom.desks.find((d) => d.employeeId === 'e1')!;
    staleDesk.x = 38;
    staleDesk.y = 21;
    staleDesk.pinned = true;

    const after = gen(departments, [emp('e1', 'engineering')], stale);

    // Presence first — an empty array would make the field assertions
    // below vacuous.
    expect(after.droppedPins).toHaveLength(1);
    expect(after.droppedPins[0]).toMatchObject({
      employeeId: 'e1',
      from: { x: 38, y: 21 },
      reason: 'room_no_longer_contains_desk',
    });
    // And they still got a real desk rather than being left standing.
    expect(deskOf(after.layout, 'e1')).toBeDefined();
  });

  it('drops the LOSER when two pins collide on one slot, naming it', () => {
    const departments = [dept('engineering')];
    const base = gen(departments, [emp('e1', 'engineering'), emp('e2', 'engineering')]).layout;
    const collided = FloorLayoutSchema.parse(JSON.parse(JSON.stringify(base)));
    const room = roomFor(collided, 'engineering');
    const slot = room.desks[0]!;
    for (const desk of room.desks) {
      desk.employeeId = null;
      desk.pinned = false;
    }
    // Both pinned to the same coordinate — only possible from a corrupted
    // or hand-edited layout, but it must not crash or seat two people at
    // one desk.
    room.desks[0]!.employeeId = 'e1';
    room.desks[0]!.pinned = true;
    const shadow = { ...slot };
    room.desks.push({ x: shadow.x, y: shadow.y, employeeId: 'e2', pinned: true });

    const after = gen(departments, [emp('e1', 'engineering'), emp('e2', 'engineering')], collided);

    expect(after.droppedPins).toHaveLength(1);
    expect(after.droppedPins[0]!.reason).toBe('slot_taken');
    expect(deskOf(after.layout, 'e1')).toBeDefined();
    expect(deskOf(after.layout, 'e2')).toBeDefined();
    expect(deskOf(after.layout, 'e1')).not.toEqual(deskOf(after.layout, 'e2'));
  });

  it('stays byte-identical across regeneration WITH pins present', () => {
    // The determinism test above uses a pin-free layout, so it could not
    // catch a regression in the pin path. This is the version of the
    // milestone gate that would.
    const departments = [dept('engineering')];
    const base = gen(departments, [emp('e1', 'engineering'), emp('e2', 'engineering')]).layout;
    const pinned = pin(base, 'e2');
    const employees = [emp('e1', 'engineering'), emp('e2', 'engineering')];
    const a = gen(departments, employees, pinned).layout;
    const b = gen(departments, employees, pinned).layout;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
