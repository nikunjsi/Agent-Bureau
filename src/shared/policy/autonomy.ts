import type { Autonomy } from '../models/enums';

/**
 * §28 M6 item 5 / CLAUDE.md's named trap: "Do not overwrite
 * `employees.autonomy` from a runtime probe. Compute an effective value."
 *
 * `employees.autonomy` is a real, always-set, required column — whatever
 * hires an employee (M7/M9, not built yet) must already supply a concrete
 * value, so there is no role-default/settings-default fallback left to
 * compute here. The one real thing "effective, not persisted" protects
 * against is §11.2's own requirement: *"`autonomous` requires an explicit
 * confirmation dialog the first time."* Nothing currently records that a
 * user has seen and accepted it, so a stored `autonomy: 'autonomous'`
 * cannot be trusted at face value until it has been.
 *
 * Downgrades one notch (`autonomous` -> `guided`, not all the way to
 * `ask`) on the reasoning that `guided` is the documented default — an
 * employee whose autonomous upgrade hasn't been confirmed behaves as if
 * it were never upgraded, not as if newly hired under maximum suspicion.
 * This is a judgment call the spec doesn't spell out verbatim.
 *
 * `autonomousConfirmedAt` is the real seam M9's confirmation dialog will
 * write to (`employees.autonomous_confirmed_at`, migration
 * 0004_autonomy_confirmation.sql) — no dialog exists yet, so nothing in
 * production sets it, and every stored `autonomous` employee downgrades
 * until it does. That is intentional, not a bug to "fix" by defaulting it
 * to confirmed.
 */
/**
 * §7.3's ungateable-engine floor, on its own so a caller that has already
 * resolved an effective autonomy (the policy evaluator, which applies the
 * breaker's constraint in the same place) can apply just this clause
 * without pretending to re-run the confirmation check.
 */
export function applyUngateableEngineFloor(
  autonomy: Autonomy,
  capabilities: { permissionCallback: boolean; hookInterception: boolean },
): Autonomy {
  return !capabilities.permissionCallback && !capabilities.hookInterception ? 'ask' : autonomy;
}

export function computeEffectiveAutonomy(
  employee: {
    autonomy: Autonomy;
    autonomous_confirmed_at: string | null;
  },
  /**
   * §7.3's other half (AUDIT #11): "Policy interception is mandatory. If
   * the engine offers neither a permission callback nor a hook mechanism,
   * we cannot gate individual tool calls."
   *
   * Optional because several call sites legitimately have no probe result
   * in hand (and did not before this existed); omitting it preserves the
   * previous behaviour exactly. Where capabilities ARE known, this clause
   * is not advisory — an engine whose tool calls cannot be intercepted
   * gets `ask` no matter what the employee was hired at.
   */
  capabilities?: { permissionCallback: boolean; hookInterception: boolean },
): Autonomy {
  // Checked FIRST and returned outright: this is a floor, not a one-notch
  // downgrade. `guided` on an ungateable engine would still let writes and
  // commands through unreviewed, which is the exact thing §7.3 exists to
  // prevent — so it drops to `ask` too, not just `autonomous`.
  if (capabilities && applyUngateableEngineFloor(employee.autonomy, capabilities) === 'ask') {
    return 'ask';
  }
  if (employee.autonomy === 'autonomous' && employee.autonomous_confirmed_at === null) {
    return 'guided';
  }
  return employee.autonomy;
}
