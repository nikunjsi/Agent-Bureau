import { Setup } from './setup';
import { Company } from './company';
import { Projects } from './projects';
import { Chat } from './chat';
import { Brief } from './brief';
import { Plan } from './plan';
import { Tasks } from './tasks';
import { Checkpoints } from './checkpoints';
import { Employees } from './employees';
import { Phases } from './phases';
import { Deliverables } from './deliverables';
import { Artifacts } from './artifacts';
import { Memory } from './memory';
import { Packs } from './packs';
import { Activity } from './activity';
import { Floor } from './floor';
import { Settings } from './settings';
import { System } from './system';
import { Workspace } from './workspace';
import { Costs } from './costs';

/**
 * Every method's `{input, output}` Zod schema pair, keyed exactly like
 * `IPC_METHODS` in `../methodList.ts` (same namespace names, same method
 * names — `scripts/checkIpcSurface.mjs` and this file's own consumers
 * both rely on that correspondence holding). This is what
 * `src/main/ipc/router.ts` looks up per channel to validate input and
 * shape output.
 */
export const IPC_SCHEMAS = {
  setup: Setup,
  company: Company,
  projects: Projects,
  chat: Chat,
  brief: Brief,
  plan: Plan,
  tasks: Tasks,
  checkpoints: Checkpoints,
  employees: Employees,
  phases: Phases,
  deliverables: Deliverables,
  artifacts: Artifacts,
  memory: Memory,
  packs: Packs,
  activity: Activity,
  floor: Floor,
  settings: Settings,
  system: System,
  workspace: Workspace,
  costs: Costs,
} as const;

export * from './common';
export * from './events';
export {
  Setup,
  Company,
  Projects,
  Chat,
  Brief,
  Plan,
  Tasks,
  Checkpoints,
  Employees,
  Phases,
  Deliverables,
  Artifacts,
  Memory,
  Packs,
  Activity,
  Floor,
  Settings,
  System,
  Workspace,
  Costs,
};
