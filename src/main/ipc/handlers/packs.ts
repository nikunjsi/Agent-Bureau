import { stub, type Handler } from './types';

// M7 (packs + roles + floor layout) owns all of this.
export const packsHandlers: Record<string, Handler> = {
  list: stub('M7'),
  install: stub('M7'),
  validate: stub('M7'),
  scaffold: stub('M7'),
  setEnabled: stub('M7'),
};
