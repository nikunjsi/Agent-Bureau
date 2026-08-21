import { stub, type Handler } from './types';

// The whole wizard (§15) is M13's job — M2 validates the transport only.
export const setupHandlers: Record<string, Handler> = {
  getState: stub('M13'),
  detectPrereqs: stub('M13'),
  installPrereq: stub('M13'),
  connectEngine: stub('M13'),
  setHomeFolder: stub('M13'),
  complete: stub('M13'),
};
