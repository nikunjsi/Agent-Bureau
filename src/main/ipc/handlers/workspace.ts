import { stub, type Handler } from './types';

// M5 (workspace + git) owns the real diff/file-tree plumbing.
export const workspaceHandlers: Record<string, Handler> = {
  diffForTask: stub('M5'),
  diffForEmployee: stub('M5'),
  fileTree: stub('M5'),
};
