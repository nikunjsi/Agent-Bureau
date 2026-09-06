/**
 * §6.8: "Names come from a bundled name list (culturally varied,
 * gender-varied), chosen so no two employees share a first name. The user
 * can rename anyone."
 *
 * ## Why this is a TypeScript constant and not `resources/names.yaml`
 *
 * "Bundled", not "configurable". A name list never changes at runtime, has
 * no auditability requirement, and nobody needs to edit it — renaming is
 * the customisation path, and it is per-employee. As a `.ts` constant this
 * is bundled by esbuild and cannot go missing from a build; as a YAML
 * resource it would need the three-piece packaging path (`build.mjs`,
 * `electron-builder.yml`, a resolver) whose pieces can silently disagree —
 * which is exactly why M7 session 1 had to extend the resource smoketest.
 * `pricing.yaml` earns YAML because rates change and must be checkable
 * against a provider's page. This does not.
 *
 * ## On "gender-varied"
 *
 * These names carry **no gender metadata**, deliberately. Bureau's
 * employees are AI, §15 forbids them claiming to be human, and assigning
 * them a gender is a claim the product has no business making. The spec's
 * requirement is satisfied by the POOL not being drawn from one
 * gender-associated set — which is a property of the list, tested by
 * breadth, not by a column.
 *
 * Given names only. Bureau addresses employees by first name everywhere,
 * and §6.8's uniqueness rule is a first-name rule, so a surname would be
 * decoration that the rule then has to see through.
 */
export const EMPLOYEE_NAME_POOL: readonly string[] = [
  // The list is deliberately broad across regions and naming traditions,
  // and deliberately short enough that every entry was chosen rather than
  // scraped. Alphabetical so the allocation order is obvious to a reader
  // (allocation itself is seeded, not sequential — see allocateName.ts).
  'Adaora',
  'Aditi',
  'Ahmad',
  'Aiko',
  'Alejandro',
  'Amara',
  'Anders',
  'Anjali',
  'Beatriz',
  'Bilal',
  'Camille',
  'Chidi',
  'Dara',
  'Dmitri',
  'Eitan',
  'Elena',
  'Emeka',
  'Esther',
  'Farida',
  'Felix',
  'Freya',
  'Gabriel',
  'Hana',
  'Hassan',
  'Ines',
  'Isabel',
  'Jae',
  'Jonas',
  'Kai',
  'Kenji',
  'Kwame',
  'Lars',
  'Leila',
  'Lucia',
  'Malik',
  'Marisol',
  'Mateo',
  'Mei',
  'Nadia',
  'Niamh',
  'Nikhil',
  'Nour',
  'Olamide',
  'Oskar',
  'Priya',
  'Rafael',
  'Ravi',
  'Rin',
  'Rosa',
  'Samira',
  'Sanjay',
  'Sofia',
  'Tomas',
  'Yara',
  'Yusuf',
  'Zainab',
];
