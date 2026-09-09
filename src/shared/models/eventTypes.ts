/**
 * §5.2's event taxonomy, closed.
 *
 * AUDIT #25 (M3–M6): `EventTypeSchema` was `z.string().min(1)`, so nothing
 * anywhere checked an emitted type against this list. Seven types were
 * being emitted that §5.2 did not document — `employee.off/starting/
 * thinking/blocked/waiting/failed/stopping`, produced by `Supervisor`'s
 * `` `employee.${next}` `` template expansion over every `SupervisorState`
 * — and drift in either direction was silent.
 *
 * This list is the fix, and it works in two directions at once:
 *
 *  - **At compile time.** `NewEventInput['type']` is inferred from the
 *    `z.enum` built out of this array, so `logEvent({ type: 'x.y' })` with
 *    an undocumented type fails `npm run typecheck`. That includes the
 *    template expansion: `` `employee.${SupervisorState}` `` only assigns
 *    if every state's type is listed below.
 *  - **At runtime.** Reading an `events` row whose type is not in the
 *    taxonomy fails its schema, so a row written by an older build (or by
 *    hand) surfaces rather than flowing on.
 *
 * §5.2's own rule — "adding a type is a code change **and** a doc change"
 * — is what this file makes true. Add a type here and to §5.2's table in
 * `docs/BUILD-SPEC.md`, in the same commit, or the code will not compile.
 */

/** Every `SupervisorState`, which `Supervisor.transition()` expands into an
 * `employee.<state>` type. Kept next to the taxonomy it feeds rather than
 * imported from `supervisor.ts`: this module is loaded by the renderer via
 * the row schemas, and `supervisor.ts` pulls in `node-pty` and the whole
 * engine layer. The two are pinned to each other by
 * `tests/unit/models/eventTypes.test.ts`, which asserts the expansion of
 * the real type is accepted here. */
const EMPLOYEE_STATE_TYPES = [
  'employee.off',
  'employee.starting',
  'employee.idle',
  'employee.working',
  'employee.thinking',
  'employee.blocked',
  'employee.waiting',
  'employee.parked',
  'employee.failed',
  'employee.stopping',
] as const;

export const EVENT_TYPES = [
  'app.started',
  'app.stopping',
  'app.reconciled',
  'app.migrated',
  'app.updated',
  'app.crashed',
  'app.setting_changed',

  'control.origin_rejected',
  'control.token_rejected',
  'control.stale_token_deleted',
  'control.authorization_rejected',
  'control.supervisor_not_found',

  'setup.started',
  'setup.step_completed',
  'setup.prereq_detected',
  'setup.prereq_installed',
  'setup.prereq_failed',
  'setup.engine_connected',
  'setup.completed',
  'setup.abandoned',

  'company.created',
  'company.employee_hired',
  'company.employee_fired',
  'company.employee_renamed',
  'company.department_added',
  'company.pack_installed',
  'company.pack_validated',
  'company.pack_validation_failed',
  'company.floor_rearranged',

  'project.created',
  'project.stage_changed',
  'project.brief_drafted',
  'project.brief_approved',
  'project.plan_drafted',
  'project.plan_approved',
  'project.paused',
  'project.resumed',
  'project.delivered',
  'project.abandoned',
  'project.budget_set',

  ...EMPLOYEE_STATE_TYPES,
  'employee.started',
  // Documented in §5.2 and NOT emitted by anything today. Kept rather than
  // deleted, and annotated in §5.2 the same way: `ready` has no
  // `SupervisorState` to expand from (the machine goes `starting` -> `idle`),
  // and a restart currently reports as `employee.started` again. Listing them
  // costs nothing — this enum is a ceiling on what may be written, not a
  // claim that everything in it is reachable.
  'employee.ready',
  'employee.restarted',
  'employee.heartbeat_missed',
  'employee.crashed',
  'employee.orphan_killed',
  'employee.stopped',
  'employee.resumed',
  'employee.engine_version_drift',
  'employee.budget_warning',
  'employee.budget_exceeded',
  'employee.rate_limited',
  'employee.quota_exhausted',
  'employee.status_reported',

  'phase.started',
  'phase.review_requested',
  'phase.accepted',
  'phase.changes_requested',
  'phase.skipped',
  'phase.completed',

  'task.created',
  'task.assigned',
  'task.started',
  'task.blocked',
  'task.unblocked',
  'task.reassigned',
  'task.submitted_for_review',
  'task.completed',
  'task.failed',
  'task.cancelled',

  'chat.message_persisted',
  'chat.stream_started',
  'chat.stream_completed',
  'chat.stream_aborted',

  'tool.requested',
  'tool.allowed',
  'tool.denied',
  'tool.asked',
  'tool.executed',
  'tool.failed',
  'tool.loop_detected',

  'checkpoint.raised',
  'checkpoint.answered',
  'checkpoint.expired',
  'checkpoint.auto_resolved',
  'checkpoint.cancelled',

  'message.sent',
  'message.delivered',
  'message.consumed',
  'message.failed',
  'message.dead_lettered',

  'git.worktree_created',
  'git.worktree_released',
  'git.lease_acquired',
  'git.lease_reclaimed',
  'git.worktree_dirty_refused',
  'git.unexpected_commit_detected',
  'git.committed',
  'git.validator_failed',
  'git.merged',
  'git.merge_conflict',
  'git.pushed',

  'memory.injected',
  'memory.write_proposed',
  'memory.write_applied',
  'memory.write_rejected',
  'memory.indexed',

  'deliverable.created',
  'deliverable.updated',
  'deliverable.submitted',
  'deliverable.accepted',
  'deliverable.rejected',

  'cost.turn_recorded',
  'cost.budget_threshold',
  'cost.breaker_tripped',
  'cost.zero_cost_blocked',
  'cost.counter_drift_repaired',
  'cost.oneshot_recorded',

  'director.intake_started',
  'director.question_asked',
  'director.report_sent',
  'director.escalated',
  'director.replanned',
  'director.context_compacted',
  'director.session_restarted',

  'user.message_sent',
  'user.checkpoint_answered',
  'user.employee_paused',
  'user.settings_changed',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
