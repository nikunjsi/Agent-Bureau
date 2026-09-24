import type { z } from 'zod';
import { useBureauStore } from '../store/bureauStore';
import type { ErrorPayloadSchema } from '../../../shared/models/chatPayloads';
import type { RightPanelTab } from '../store/bureauStore';

type Remedy = NonNullable<z.infer<typeof ErrorPayloadSchema>['remedy']>;

/** The settings group that holds the budget limits. */
export const BUDGET_SETTINGS_GROUP = 'Budgets';

/** The exhausted-budget checkpoint's option that means "raise it" (§8.0). */
export const RAISE_BUDGET_OPTION_ID = 'raise_budget';

/**
 * Where a remedy sends the user (M11 row S1-19). The Core names what has to
 * happen; this is where that is in this window. `raise_budget` opens the
 * real budget control — Settings, at Budgets — rather than logging that it
 * has nowhere to go, which is what it did while no Director could run out.
 */
export function followRemedy(
  remedy: Remedy | null,
  deps: {
    readonly setActiveTab: (tab: RightPanelTab) => void;
    readonly openPath: (path: string) => void;
  },
): void {
  if (remedy === null) return;
  switch (remedy.kind) {
    case 'answer_checkpoint':
      deps.setActiveTab('checkpoints');
      return;
    case 'open_path':
      if (remedy.targetId !== null) deps.openPath(remedy.targetId);
      return;
    case 'raise_budget':
      useBureauStore.getState().openSettings(BUDGET_SETTINGS_GROUP);
      return;
    default:
      // `reconnect_engine` and `retry` still have no screen to send anyone to
      // (settings panels are M13, retry needs the composer). The button is
      // rendered and this is where its destination lands when it exists.
      console.warn(`[chat] no destination yet for remedy '${remedy.kind}'`);
  }
}

/**
 * After a checkpoint answer the Core accepted (M11 row S1-19): answering the
 * exhausted-budget checkpoint with "Raise the budget" takes the user to the
 * control that does it. Recording the answer does not raise anything.
 */
export function afterCheckpointAnswer(optionId: string | undefined): void {
  if (optionId === RAISE_BUDGET_OPTION_ID) {
    useBureauStore.getState().openSettings(BUDGET_SETTINGS_GROUP);
  }
}
