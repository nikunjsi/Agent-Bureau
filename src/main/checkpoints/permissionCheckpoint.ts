import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { insertCheckpoint } from '../db/repositories/checkpoints';
import { getEmployeeById } from '../db/repositories/employees';
import { loadCheckpointTimeoutSettings } from './expiry';
import type { Checkpoint } from '../../shared/models/checkpoint';

/**
 * §9.1's sixth type — "an employee at `ask` autonomy wants to run one
 * specific action" — built where the policy evaluator's `ask` verdict
 * actually happens.
 *
 * Before M8, `server.ts` handled an `ask` by creating a hold and nothing
 * else, with an honest comment saying so: "nothing before M8 can resolve a
 * held 'ask' to anything but the maxHoldMinutes timeout-to-deny". This is
 * the row that makes it resolvable by a person.
 *
 * ## Two options, not three — a decision, with its reasoning
 *
 * §9.1 describes the compact render as "allow once / allow this command
 * for this employee / deny". The middle option is **not built**, and the
 * reason is structural rather than schedule pressure: §11.3's rule sources
 * are the immutable globals, the role, and (M7) the pack. There is no
 * store anywhere for a rule a *user* granted, and inventing one inside M8
 * would put a policy decision outside the policy layer — a second place
 * deciding what an employee may run. Recorded in `docs/NEXT-VERSION.md`
 * with the two honest ways to build it later.
 *
 * So the row carries `allow_once` and `deny`, both real, both with the
 * consequence §9.2 requires.
 *
 * ## The default is hardcoded `deny`, and this is the one structural #7
 *
 * Everywhere else, "the default is the safe, reversible option" is an
 * authored claim a schema cannot verify. Here it is not authored at all:
 * `deny` is written by this function, and a timeout or a dead hold
 * therefore cannot do anything but refuse. That is CLAUDE.md invariant #6
 * (fail closed) and #7 (a timeout never causes an irreversible action)
 * holding by construction — the same conclusion `PolicyHoldRegistry`'s own
 * timeout already reaches from the other side.
 */
export interface PermissionCheckpointInput {
  readonly employeeId: string;
  /** The hold's key. Becomes `tool_call_id`, which is how answering finds
   * the hold to release. */
  readonly callId: string;
  /** The classified tool name (§11.3), e.g. `Bash`. */
  readonly tool: string;
  /** The engine's own raw name, when it differs — shown to the user. */
  readonly rawTool?: string | null;
  /** A short, already-redacted rendering of the arguments (§7.10's
   * `preview`). Truncated here rather than trusted to be short: this
   * string is rendered in a compact card, and a 4 KB command line would
   * make the card unreadable. */
  readonly argsPreview: string | null;
  /** The evaluator's own reason for asking. */
  readonly reason: string;
  readonly projectId?: string | null;
  readonly taskId?: string | null;
  /**
   * How long the Core will hold the agent, in minutes — resolved ONCE by
   * `ControlChannelServer` and passed in, so the row's `expires_at` and
   * the hold's own timer are the same number rather than two that happen
   * to agree. See `insertCheckpoint`'s note on `timeoutSettings`.
   */
  readonly holdMinutes: number;
}

const ARGS_PREVIEW_MAX = 400;

export function createPermissionCheckpoint(
  db: Database.Database,
  activityLog: ActivityLog,
  input: PermissionCheckpointInput,
): Checkpoint {
  const employee = getEmployeeById(db, input.employeeId);
  const who = employee?.name ?? 'An employee';
  const displayTool = input.rawTool ?? input.tool;
  const preview = truncate(input.argsPreview, ARGS_PREVIEW_MAX);

  // The other two fields are irrelevant to a permission checkpoint —
  // `computeExpiresAt` branches on the type before it reads them — but the
  // struct is loaded rather than faked so that stays true by construction
  // if the branch ever changes.
  const timeoutSettings = {
    ...loadCheckpointTimeoutSettings(db),
    maxHoldMinutes: input.holdMinutes,
  };

  return insertCheckpoint(
    db,
    activityLog,
    {
      project_id: input.projectId ?? null,
      task_id: input.taskId ?? null,
      employee_id: input.employeeId,
      type: 'permission',
      urgency: 'blocking',
      tool_call_id: input.callId,
      tool_name: input.tool,
      args_preview: preview,
      // §9.2's "written for a non-expert": the sentence a person reads is
      // "who wants to do what", not the rule id that produced the ask.
      title:
        preview === null ? `${who} wants to run ${displayTool}` : `${who} wants to run: ${preview}`,
      context: `${who} is set to ask before actions like this one. ${input.reason} Nothing has happened yet — ${who} is waiting for your answer and cannot continue until you give one.`,
      options: [
        {
          id: 'allow_once',
          label: 'Allow, just this once',
          detail: `Runs ${displayTool} now.`,
          consequence: 'This one action runs. The next action like it will ask again.',
          // Whatever the tool would do, it will have been done (X-9).
          reversible: false,
        },
        {
          id: 'deny',
          label: "Don't allow",
          detail: `Refuses ${displayTool}.`,
          consequence:
            'The action is refused and the employee is told so; it will try something else or report that it is stuck.',
          recommended: true,
          // The one option in the app whose safety is structural rather than
          // authored: nothing ran, and the agent may ask again. It is why
          // this checkpoint may expire at all (X-9, §9.5).
          reversible: true,
        },
      ],
      preview: null,
      default_action: 'deny',
    },
    timeoutSettings,
  );
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
