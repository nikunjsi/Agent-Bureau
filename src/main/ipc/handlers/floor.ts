import { stub, type Handler } from './types';

// M12 (floor rendering) owns all of this. CLAUDE.md: "do not build the
// Floor before the Director works" — M2's FloorPane is an empty-state
// placeholder only (no Phaser), and these stay stubs until then.
export const floorHandlers: Record<string, Handler> = {
  getLayout: stub('M12'),
  moveDesk: stub('M12'),
  resetLayout: stub('M12'),
};
