/**
 * §14.2's six slash commands, as names — the one list, imported by both
 * sides.
 *
 * The renderer needs them to write a hint line under the composer; the
 * main process needs them to parse. Two hardcoded lists would be standing
 * rule 6's exact shape, and the drift would be invisible: a hint naming a
 * command the parser no longer knows falls through to the Director as
 * ordinary text, which §17.2 defines as correct behaviour for an
 * unrecognised slash — so nothing would ever fail.
 *
 * **What is NOT shared is what a command does.** §17.2 puts parsing and
 * execution in the main process precisely so `/pause`, `/budget` and
 * `/status` work when the Director is mid-generation or out of budget, and
 * a renderer that decided anything about `/pause` would be the half that
 * stops working exactly when the window is busy. This module is names.
 *
 * Six, taken as given. §14.2 lists them and M9 session 1 recorded the set
 * as one of the four expensive-to-change decisions; adding a seventh is a
 * spec change, not an implementation one.
 */
export const SLASH_COMMANDS = ['status', 'pause', 'budget', 'plan', 'deliver', 'help'] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number];
