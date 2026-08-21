import { create } from 'zustand';
import type { StateDelta } from '../../../shared/ipc/schemas/events';
import type { SettingsValues } from '../../../shared/settings/schema';
import type { Company } from '../../../shared/models/company';
import type { Project } from '../../../shared/models/project';
import type { Task } from '../../../shared/models/task';
import type { Employee } from '../../../shared/models/employee';
import type { Checkpoint } from '../../../shared/models/checkpoint';

export type RightPanelTab = 'chat' | 'board' | 'checkpoints' | 'inspector';

interface BureauState {
  /** `false` until the first `full` delta lands — every view's "loading"
   * vs. "genuinely empty" empty state reads this, not just an empty array
   * (an empty array before hydration would render "no projects yet" for
   * a fraction of a second on every launch, which is a lie). */
  hydrated: boolean;
  lastAppliedSeq: number;
  settings: SettingsValues | null;
  company: Company | null;
  projects: Project[];
  tasks: Task[];
  employees: Employee[];
  checkpoints: Checkpoint[];

  activeTab: RightPanelTab;
  setActiveTab: (tab: RightPanelTab) => void;

  /** §17.2 semantics, applied exactly as specified: a `full` delta
   * replaces every slice and resets the seq counter; a `patch` applies
   * only if its `seq` is exactly `lastAppliedSeq + 1` — anything else
   * (a gap, or arriving before the first `full`) is dropped, not
   * applied out of order, and logged so drift is visible rather than
   * silent. See schemas/events.ts for why this shape was chosen. */
  applyDelta: (delta: StateDelta) => void;
}

export const useBureauStore = create<BureauState>((set, get) => ({
  hydrated: false,
  lastAppliedSeq: 0,
  settings: null,
  company: null,
  projects: [],
  tasks: [],
  employees: [],
  checkpoints: [],

  activeTab: 'chat', // §14.1: "Chat is the default tab on every launch."
  setActiveTab: (tab) => set({ activeTab: tab }),

  applyDelta: (delta) => {
    if (delta.kind === 'full') {
      set({
        hydrated: true,
        lastAppliedSeq: delta.seq,
        settings: (delta.slices.settings as SettingsValues | undefined) ?? null,
        company: (delta.slices.company as Company | null | undefined) ?? null,
        projects: (delta.slices.projects as Project[] | undefined) ?? [],
        tasks: (delta.slices.tasks as Task[] | undefined) ?? [],
        employees: (delta.slices.employees as Employee[] | undefined) ?? [],
        checkpoints: (delta.slices.checkpoints as Checkpoint[] | undefined) ?? [],
      });
      return;
    }

    const state = get();
    if (!state.hydrated || delta.seq !== state.lastAppliedSeq + 1) {
      console.warn(
        `[stateDelta] dropped a "${delta.slice}" patch (seq ${delta.seq}) — expected ${state.hydrated ? state.lastAppliedSeq + 1 : 'a full delta first'}. Waiting for the next full delta.`,
      );
      return;
    }
    set({ lastAppliedSeq: delta.seq, [delta.slice]: delta.value });
  },
}));
