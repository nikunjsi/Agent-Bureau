import {
  getEmployeeById,
  listEmployees,
  setEmployeeAutonomy,
  setEmployeeDailyBudget,
  setEmployeeModelTierOverride,
  setEmployeeStatus,
  setEmployeeResumeAt,
} from '../../db/repositories/employees';
import { ipcOk, ipcError } from '../../../shared/ipc/envelope';
import { Employees as EmployeesSchemas } from '../../../shared/ipc/schemas/employees';
import type { Supervisor } from '../../engine/supervisor';
import { stub, type Handler, type HandlerContext } from './types';

/**
 * The active roster. Archived employees (§6.8 — fired, memory kept) are
 * excluded: they are not on the floor, not assignable, and showing them
 * would make "who works here" a question with a surprising answer. The
 * support bundle is the one place that wants the whole history, and it
 * asks for it explicitly.
 */
function listActiveEmployees(ctx: HandlerContext) {
  return listEmployees(ctx.db);
}

/**
 * Resolves the live Supervisor for an employee, or an honest error.
 *
 * Two distinguishable failures, and conflating them would be the useless
 * kind of error message: the employee may not exist at all (NOT_FOUND), or
 * they may exist with no running process — which is the ordinary case for
 * anyone who is `off`, and means there is nothing to pause or interrupt.
 */
function resolveSupervisor(
  ctx: HandlerContext,
  id: string,
): { supervisor: Supervisor } | { error: ReturnType<typeof ipcError> } {
  if (getEmployeeById(ctx.db, id) === null) {
    return { error: ipcError('NOT_FOUND', `No employee with id "${id}".`) };
  }
  const supervisor = ctx.supervisorRegistry?.get(id);
  if (supervisor === undefined) {
    return {
      error: ipcError(
        'NOT_FOUND',
        'That employee is not currently running, so there is nothing to act on.',
        { type: 'retry' },
      ),
    };
  }
  return { supervisor };
}

/**
 * §14.5's user controls. Real as of M7 session 2 — session 1 deferred them
 * because nothing could hire, so no Supervisor could ever be in the
 * registry to find.
 */
const pause: Handler = async (input, ctx) => {
  const { id } = EmployeesSchemas.pause.input.parse(input);
  const resolved = resolveSupervisor(ctx, id);
  if ('error' in resolved) return resolved.error;

  // Note what this deliberately does NOT do: refuse the Director. Any
  // operation that could remove the user's only way back must refuse
  // (that is why `fireEmployee` does), but a pause is undoable — see
  // `resumeEmployee` below, which is now genuinely reachable.
  await resolved.supervisor.pause();
  return ipcOk(EmployeesSchemas.pause.output.parse({ ok: true }));
};

/**
 * The undo, and the reason it had to grow a second branch in M9 session 2.
 *
 * Until this milestone nothing in the renderer called `pause` OR
 * `resumeEmployee`, so the asymmetry between them was invisible. §14.2's
 * `/pause` makes pausing reachable, and standing rule 5 then requires that
 * un-pausing be reachable **in every state a pause can leave the product
 * in** — which turned out to include one this handler could not serve:
 *
 *   - A manual pause writes `employees.status = 'parked'` and **never sets
 *     `resume_at`** (only `parkForQuotaExhaustion` does).
 *   - `promoteResumableParkedEmployees` — the only thing that un-parks
 *     without a live Supervisor, called by both `reconcile()` and the 60 s
 *     tick — promotes only rows where `resume_at IS NOT NULL`.
 *   - `sweepOrphans` kills processes and never touches `status`.
 *   - Nothing respawns employees before M11.
 *
 * So after a restart the row sat `parked` forever and this handler said
 * "not currently running, nothing to act on" — a dead end with no surface
 * that could lift it. `Supervisor.pause()`'s own comment cited standing
 * rule 5 as satisfied *because `resume()` needs no model call*, which was
 * true of the Core and false of the product: it assumed something reached
 * `resume()`, and nothing did.
 *
 * One decision — is there a live process? — with two correct answers:
 * `Supervisor.resume()` when there is, and the same `parked → off`
 * promotion `promoteResumableParkedEmployees` performs when there is not.
 * Not two definitions of un-parking: `off` is exactly what an employee
 * with no process is, and normal assignment restarts it from there.
 */
const resumeEmployee: Handler = (input, ctx) => {
  const { id } = EmployeesSchemas.resumeEmployee.input.parse(input);
  const employee = getEmployeeById(ctx.db, id);
  if (employee === null) {
    return ipcError('NOT_FOUND', `No employee with id "${id}".`, { type: 'retry' });
  }

  const supervisor = ctx.supervisorRegistry?.get(id);
  if (supervisor !== undefined) {
    if (!supervisor.resume()) {
      return ipcError('VALIDATION_FAILED', 'That employee is not paused.');
    }
    return ipcOk(EmployeesSchemas.resumeEmployee.output.parse({ ok: true }));
  }

  // No live process. The row is still the truth about whether they are
  // stopped, and it is the only thing left to change.
  if (employee.status !== 'parked') {
    return ipcError('VALIDATION_FAILED', 'That employee is not paused.');
  }
  const promote = ctx.db.transaction(() => {
    setEmployeeStatus(ctx.db, id, 'off');
    setEmployeeResumeAt(ctx.db, id, null);
  });
  promote();
  ctx.activityLog.logEvent({
    actor: 'user',
    type: 'employee.resumed',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: id,
    checkpoint_id: null,
    // Distinguishable from the resume tick's own `employee.resumed`, which
    // carries a null payload: this one was a person pressing a button on a
    // stopped employee with no process, the case the tick cannot reach.
    payload: { via: 'user_resume_without_process' },
  });
  return ipcOk(EmployeesSchemas.resumeEmployee.output.parse({ ok: true }));
};

const interrupt: Handler = async (input, ctx) => {
  const { id } = EmployeesSchemas.interrupt.input.parse(input);
  const resolved = resolveSupervisor(ctx, id);
  if ('error' in resolved) return resolved.error;

  if (!(await resolved.supervisor.interruptNow())) {
    // §7.6: claude-code's structured mode genuinely cannot be interrupted.
    // Reporting success would be a lie the user acts on.
    return ipcError(
      'VALIDATION_FAILED',
      'This engine cannot interrupt a turn in progress. Pause the employee to stop them after this turn.',
    );
  }
  return ipcOk(EmployeesSchemas.interrupt.output.parse({ ok: true }));
};

/**
 * Settings live on the employee ROW, not on the Supervisor: the policy
 * evaluator reads autonomy per check and budget enforcement reads the
 * ceiling per turn, both from the DB. So this works whether or not the
 * employee is running — which is the point, since changing someone's
 * autonomy before starting them is the normal case.
 */
const updateSettings: Handler = (input, ctx) => {
  const parsed = EmployeesSchemas.updateSettings.input.parse(input);
  const employee = getEmployeeById(ctx.db, parsed.id);
  if (employee === null) {
    return ipcError('NOT_FOUND', `No employee with id "${parsed.id}".`, { type: 'retry' });
  }

  // X-7 / §8.0: the Director's autonomy is fixed at `guided` and is not the
  // user's to change — `director.yaml` says this is enforced in code, and
  // until now it was not. Refused before anything is written, so a call that
  // also carried a budget change writes neither; the caller can send the
  // budget on its own. Budget and model tier ARE the user's to set.
  if (employee.is_director && parsed.autonomy !== undefined) {
    return ipcError(
      'VALIDATION_FAILED',
      "The Director's autonomy is fixed: it always asks before anything meaningful. You can still change its budget and model.",
      { type: 'retry' },
    );
  }

  const write = ctx.db.transaction(() => {
    if (parsed.autonomy !== undefined) setEmployeeAutonomy(ctx.db, parsed.id, parsed.autonomy);
    if (parsed.dailyBudgetUsdMicros !== undefined) {
      setEmployeeDailyBudget(ctx.db, parsed.id, parsed.dailyBudgetUsdMicros);
    }
    // A TIER, not a model id. The old `model` field wrote a column the
    // spawn never read — the M7→M4 boundary finding. See the IPC schema.
    if (parsed.modelTierOverride !== undefined) {
      setEmployeeModelTierOverride(ctx.db, parsed.id, parsed.modelTierOverride);
    }
  });
  write();

  ctx.activityLog.logEvent({
    actor: 'user',
    type: 'user.settings_changed',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: parsed.id,
    checkpoint_id: null,
    payload: {
      // Only what was actually sent — recording `undefined` fields as
      // nulls would make the log claim the user cleared them.
      ...(parsed.autonomy !== undefined ? { autonomy: parsed.autonomy } : {}),
      ...(parsed.dailyBudgetUsdMicros !== undefined
        ? { dailyBudgetUsdMicros: parsed.dailyBudgetUsdMicros }
        : {}),
      ...(parsed.modelTierOverride !== undefined
        ? { modelTierOverride: parsed.modelTierOverride }
        : {}),
    },
  });

  return ipcOk(EmployeesSchemas.updateSettings.output.parse({ ok: true }));
};

export const employeesHandlers: Record<string, Handler> = {
  list: (_input, ctx) => ipcOk({ items: listActiveEmployees(ctx) }),
  get: (input, ctx) => {
    const { id } = EmployeesSchemas.get.input.parse(input);
    return ipcOk({ item: getEmployeeById(ctx.db, id) });
  },
  pause,
  resumeEmployee,
  interrupt,
  updateSettings,
  // The Inspector's four (§14.5, M14). Re-tagged from `M7` in session 1
  // and left here on purpose: taking control of an employee's terminal,
  // streaming keystrokes to it, and resizing its PTY are all operations on
  // a UI that does not exist, and `resizePty` additionally needs a
  // `resize()` on EngineAdapter that is deliberately not added ahead of
  // its caller. The supervisor-side mechanism (takeControl /
  // releaseControl / sendControlInput, TerminalBroadcaster's read-only
  // gate and fanout) has been real and tested since M3 session 3.
  takeControl: stub('M14'),
  releaseControl: stub('M14'),
  sendInput: stub('M14'),
  resizePty: stub('M14'),
};
