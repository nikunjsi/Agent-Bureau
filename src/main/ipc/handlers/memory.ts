import { stub, type Handler } from './types';

// M10 (memory retrieval + gated writes) owns all of this.
export const memoryHandlers: Record<string, Handler> = {
  list: stub('M10'),
  read: stub('M10'),
  write: stub('M10'),
  remove: stub('M10'),
  search: stub('M10'),
  reindex: stub('M10'),
};
