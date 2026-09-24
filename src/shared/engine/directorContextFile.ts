/**
 * The file the Director's assembled context (§8.0.1) is written to, in its
 * state directory, before each turn (M11 context assembly). The claude-code
 * adapter hands it to the CLI as an appended system prompt, with the CLI's
 * system-prompt snapshot off, so every turn — resumed or not — sees the
 * context as it is now rather than as it was on the first turn.
 */
export const DIRECTOR_CONTEXT_FILE = 'director-context.md';
