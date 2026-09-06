# Engineering conventions

Seeded by the engineering pack. This is **your** file now — edit it freely.
Bureau will not overwrite changes you make here, and every engineering
employee reads it.

## Defaults this company starts with

- **The project's own conventions win.** Anything below is a starting
  point for a codebase that has not decided yet.
- **Small changes.** One task, one coherent change. Unrelated fixes go in
  the report, not the diff.
- **Tests that were watched failing.** A test nobody saw fail is a guess.
- **Errors surface.** No silently swallowed exceptions, no checks whose
  result nothing reads.
- **Pinned versions** for dependencies and toolchains.
- **No secrets in the repository**, including in fixtures and examples.

## Things worth writing down here later

- Which languages and frameworks this company actually uses.
- The house style on comments, naming, and file layout.
- Which test runner and how to invoke it.
- Anything an employee got wrong once and should not get wrong twice.
