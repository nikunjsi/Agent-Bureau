/**
 * **Where "is this employee the Director" is decided — once.**
 *
 * §8.0 defines the Director as one specific role: the `director` role in
 * the bundled `operations` pack. Not "any role called director" — a
 * third-party pack shipping `somepack:director` installs an ordinary
 * employee, because §8.0's Director is a specific set of tools, a fixed
 * `guided` autonomy, a budget reserve and a breaker exemption, all of
 * which come from `packs/operations/roles/director.yaml`.
 *
 * Standing rule 6 is why this is a module rather than a string literal in
 * `hireEmployee`. Three things ask the same question — the `employees`
 * insert, the floor layout's input (§13.5's corner office), and the
 * refusal to hire a second one — and if any of them derived it separately
 * they would each be individually testable and jointly wrong, exactly the
 * M7→M4 model-tier failure this rule was written for.
 *
 * The *reader* of the answer is `employees.is_director`, written once at
 * hire. `companies.director_employee_id` (§5.1.1) is written in the same
 * transaction because the schema requires the pointer, but nothing derives
 * the answer from it — see `hireEmployee`.
 */

/** `roles.full_key`, i.e. `<pack key>:<role key>`. */
export const DIRECTOR_ROLE_FULL_KEY = 'operations:director';

export function isDirectorRole(roleFullKey: string): boolean {
  return roleFullKey === DIRECTOR_ROLE_FULL_KEY;
}
