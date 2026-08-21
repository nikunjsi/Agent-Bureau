import type { IpcNamespace } from '../../../shared/ipc/methodList';
import { setupHandlers } from './setup';
import { companyHandlers } from './company';
import { projectsHandlers } from './projects';
import { chatHandlers } from './chat';
import { briefHandlers } from './brief';
import { planHandlers } from './plan';
import { tasksHandlers } from './tasks';
import { checkpointsHandlers } from './checkpoints';
import { employeesHandlers } from './employees';
import { phasesHandlers } from './phases';
import { deliverablesHandlers } from './deliverables';
import { artifactsHandlers } from './artifacts';
import { memoryHandlers } from './memory';
import { packsHandlers } from './packs';
import { activityHandlers } from './activity';
import { floorHandlers } from './floor';
import { settingsHandlers } from './settings';
import { systemHandlers } from './system';
import { workspaceHandlers } from './workspace';
import { costsHandlers } from './costs';
import type { Handler } from './types';

export type { Handler, HandlerContext } from './types';

/** Keyed exactly like `IPC_METHODS`/`IPC_SCHEMAS` — see router.ts's
 * `getMethodSchema` for the same correspondence-by-construction note. */
const HANDLERS: Record<string, Record<string, Handler>> = {
  setup: setupHandlers,
  company: companyHandlers,
  projects: projectsHandlers,
  chat: chatHandlers,
  brief: briefHandlers,
  plan: planHandlers,
  tasks: tasksHandlers,
  checkpoints: checkpointsHandlers,
  employees: employeesHandlers,
  phases: phasesHandlers,
  deliverables: deliverablesHandlers,
  artifacts: artifactsHandlers,
  memory: memoryHandlers,
  packs: packsHandlers,
  activity: activityHandlers,
  floor: floorHandlers,
  settings: settingsHandlers,
  system: systemHandlers,
  workspace: workspaceHandlers,
  costs: costsHandlers,
};

export function getHandler(namespace: IpcNamespace, method: string): Handler {
  const handler = HANDLERS[namespace]?.[method];
  if (!handler) {
    throw new Error(`No handler registered for ${namespace}.${method} — methodList.ts and handlers/index.ts have drifted`);
  }
  return handler;
}
