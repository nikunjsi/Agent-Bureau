import { useState } from 'react';
import { useBureauStore } from '../../store/bureauStore';
import { ErrorNotice, type NoticeError } from '../ErrorNotice';

/**
 * **The way back from `/pause`, and the reason it is a banner rather than
 * a button on a message.**
 *
 * Before M9 session 2 nothing in the renderer called `employees.pause` or
 * `employees.resumeEmployee`, so an asymmetry between them had never been
 * visible: `Supervisor.pause()`'s own comment argued a pause is safe
 * "because `resume()` needs no model call", and nothing called `resume()`.
 * Worse, a manual pause leaves `resume_at` null, which is exactly what
 * `promoteResumableParkedEmployees` requires — so after a restart the row
 * stayed `parked` with no surface able to lift it.
 *
 * §14.2's `/pause` makes pausing reachable, and standing rule 5 then
 * requires the undo be reachable **in every state a pause can leave the
 * product in**, including "the app was closed and reopened". So:
 *
 *  - It reads **live state** (`employees`, from the Core's own snapshot),
 *    not a payload on the `/pause` message. A button on a message is gone
 *    the moment the transcript scrolls, and after a restart the message is
 *    still there while the button's assumptions are not. This is the same
 *    discipline the checkpoint card uses.
 *  - It disappears on its own when nobody is stopped, because the
 *    condition it renders is the condition it describes.
 *  - `employees.resumeEmployee` serves both cases behind it — a live
 *    Supervisor, and a `parked` row with no process at all.
 *
 * Wording is deliberately neutral about *why* someone is stopped: `parked`
 * covers a manual pause, a budget stop and an exhausted quota, and resuming
 * is the right offer for all three (a budget-stopped employee simply stops
 * again on its next turn, which is information rather than damage).
 *
 * **But it is NOT neutral about whether they will come back on their own**,
 * because those two cases genuinely differ and saying one sentence for both
 * would make it false for half of them. `resume_at` is the fact: an
 * employee parked for an exhausted quota has one, and `reconcile()` plus the
 * §24.3 tick resume them when it passes — including across a restart. A
 * manually paused employee has none, and nothing will ever un-park them.
 * The first draft of this banner claimed "closing Bureau does not restart
 * them" for everyone, which was true of the case it was written for and
 * false of the other.
 */
export function PausedBanner(): React.JSX.Element | null {
  const employees = useBureauStore((state) => state.employees);
  const [resuming, setResuming] = useState(false);
  /**
   * AUDIT M0–M2 #16 — a LIST of failures, not a joined string.
   *
   * Resuming everyone can fail for several employees at once for several
   * different reasons, and the first version of this rolled them into one
   * sentence. That is precisely how §14.6's "concrete next action" gets
   * lost: N errors, each with its own action, flattened into one string
   * with none. One notice per failure keeps each one's next step.
   */
  const [failures, setFailures] = useState<Array<{ name: string; error: NoticeError }>>([]);

  const parked = employees.filter((employee) => employee.status === 'parked');
  if (parked.length === 0) return null;

  // Split on the fact, not on a guess about why. `resume_at` is set only by
  // the quota path (§24.3), and it is what `promoteResumableParkedEmployees`
  // acts on.
  const stuck = parked.filter((employee) => employee.resume_at === null);
  const scheduled = parked.filter((employee) => employee.resume_at !== null);

  const resumeAll = async (): Promise<void> => {
    setResuming(true);
    setFailures([]);
    const refused: Array<{ name: string; error: NoticeError }> = [];
    for (const employee of parked) {
      const result = await window.bureau.employees.resumeEmployee({ id: employee.id });
      if (!result.ok) refused.push({ name: employee.name, error: result.error });
    }
    setResuming(false);
    // No optimistic update: the roster comes back from the Core's own
    // pushed snapshot, and this banner goes when the Core says they are no
    // longer parked (invariant #11).
    setFailures(refused);
  };

  return (
    <section
      // A named region: a screen-reader user tabbing past the transcript
      // needs to know what this strip is before reading it, and it is the
      // one control on this screen that undoes something.
      aria-label="Stopped employees"
      className="border-t border-bureau-warn/50 bg-bureau-warn/10 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Icon plus words (§14.7) — the state is not the amber. */}
        <p className="flex-1 text-sm text-bureau-text">
          <span aria-hidden="true">⏸</span>{' '}
          <strong>
            {parked.length} {parked.length === 1 ? 'person is' : 'people are'} stopped
          </strong>{' '}
          — {parked.map((employee) => employee.name).join(', ')}. They will not take another turn
          until they are resumed.
          {stuck.length > 0 && ' Closing Bureau does not restart them.'}
          {scheduled.length > 0 &&
            ` ${scheduled.length === parked.length ? 'They' : `${scheduled.length} of them`} would start again on their own once a limit resets, if you would rather wait.`}
        </p>
        <button
          type="button"
          disabled={resuming}
          onClick={() => void resumeAll()}
          className="rounded border border-bureau-border bg-bureau-bg px-3 py-1 text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        >
          {resuming ? 'Resuming…' : parked.length === 1 ? 'Resume' : 'Resume everyone'}
        </button>
      </div>
      {failures.map((failure) => (
        <ErrorNotice
          key={failure.name}
          about={failure.name}
          error={failure.error}
          className="mt-1"
        />
      ))}
    </section>
  );
}
