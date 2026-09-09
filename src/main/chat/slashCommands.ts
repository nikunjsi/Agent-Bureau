import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import { listEmployees } from '../db/repositories/employees';
import { getSoleCompany } from '../db/repositories/companies';
import { listPendingCheckpoints } from '../db/repositories/checkpoints';
import { getSetting } from '../db/repositories/settings';
import { getUsageSince } from '../db/repositories/usage';
import { localMidnightIso } from '../cost/budgetCheck';
import { microsToUsd } from '../../shared/models/money';
import { SLASH_COMMANDS, type SlashCommand } from '../../shared/chat/slashCommands';

export { SLASH_COMMANDS, type SlashCommand };

/**
 * §17.2, and its reason is the whole design:
 *
 * > **Slash commands are parsed in the main process** before reaching the
 * > Director, so `/pause`, `/budget`, and `/status` work even when the
 * > Director is mid-generation or out of budget. The parsed command is
 * > echoed into the conversation as a `system` message. Unrecognised
 * > slashes are passed through as ordinary text.
 *
 * That reason is testable and is tested: `/pause` is exercised with a live
 * `ChatStream` open, and `/budget` with the ledger genuinely over
 * `budgets.dailyUsd`. A parser unit test proves neither.
 *
 * ## What makes something a command
 *
 * The **entire trimmed body** must be exactly one of the six, ignoring
 * case. Nothing else. That rule is what makes §17.2's "unrecognised
 * slashes pass through as ordinary text" true for the cases that matter:
 * `/tmp/foo.log` in a sentence is text, and so is `/help me understand the
 * plan`, which a first-token match would have swallowed into a command
 * that takes no arguments. Recognising less is the safe direction here —
 * a command misread as text reaches the Director, which is where text was
 * going anyway.
 *
 * ## The response is prose, and that is not a presentation leak
 *
 * The Core writes `body` for every message in this product; a Director
 * reply is prose the Core authored, and so is a checkpoint option's
 * `consequence` and an error payload's `explanation`. What the Core must
 * not do is decide how something *looks* — colours, icons, button labels,
 * layout flags, routes. A `/status` answer is content. The alternative,
 * a structured `status` payload, would need a ninth `kind`, which session
 * 1 named as the signal that something else has gone wrong.
 */

/** `null` when the body is ordinary text — including a body that merely
 * begins with a slash. */
export function parseSlashCommand(body: string): SlashCommand | null {
  const trimmed = body.trim().toLowerCase();
  if (!trimmed.startsWith('/')) return null;
  const name = trimmed.slice(1);
  return (SLASH_COMMANDS as readonly string[]).includes(name) ? (name as SlashCommand) : null;
}

export interface SlashCommandDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly supervisorRegistry?: SupervisorRegistry | undefined;
}

/** What `chat.send` persists as the `system` message. `body` is markdown —
 * the same subset every other message in this conversation is rendered
 * with. */
export interface SlashCommandOutcome {
  readonly body: string;
}

export async function runSlashCommand(
  deps: SlashCommandDeps,
  command: SlashCommand,
): Promise<SlashCommandOutcome> {
  switch (command) {
    case 'help':
      return { body: `${echo('/help')}\n\n${helpText()}` };
    case 'status':
      return { body: `${echo('/status')}\n\n${statusText(deps)}` };
    case 'budget':
      return { body: `${echo('/budget')}\n\n${budgetText(deps)}` };
    case 'pause':
      return { body: `${echo('/pause')}\n\n${await pauseEveryone(deps)}` };
    case 'plan':
      return { body: `${echo('/plan')}\n\n${planText(deps)}` };
    case 'deliver':
      return { body: `${echo('/deliver')}\n\n${deliverText(deps)}` };
  }
}

/** §17.2: "The parsed command is echoed into the conversation." The
 * command and its answer are ONE message, not two: the echo exists so the
 * transcript records what was asked, and a bare echo followed by a
 * separate answer would double the length of every command for nothing. */
function echo(command: string): string {
  return `\`${command}\``;
}

function helpText(): string {
  return [
    'These six commands are handled by Bureau itself, not by the Director — so they still work',
    'while the Director is busy, out of budget, or not hired yet.',
    '',
    '- `/status` — who is working, what is waiting for you, what today has cost.',
    '- `/pause` — stop every running employee. Undone with Resume, above the message box.',
    '- `/budget` — the spending limits in force and what has been spent against them.',
    '- `/plan` — the current plan, if there is one.',
    '- `/deliver` — ask for what has been built so far.',
    '- `/help` — this list.',
    '',
    'Anything else starting with `/` is sent to the Director as ordinary text.',
  ].join('\n');
}

function statusText(deps: SlashCommandDeps): string {
  const company = getSoleCompany(deps.db);
  const employees = listEmployees(deps.db);
  const pending = listPendingCheckpoints(deps.db);
  const spentToday = getUsageSince(deps.db, localMidnightIso());

  const lines: string[] = [];
  lines.push(company === null ? 'No company has been set up yet.' : `**${company.name}**`);

  if (employees.length === 0) {
    lines.push('', 'Nobody has been hired yet.');
  } else {
    const byStatus = new Map<string, string[]>();
    for (const employee of employees) {
      byStatus.set(employee.status, [...(byStatus.get(employee.status) ?? []), employee.name]);
    }
    lines.push('', `**${employees.length} employed**`);
    for (const [status, names] of [...byStatus].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push(`- ${status}: ${names.join(', ')}`);
    }
  }

  lines.push(
    '',
    pending.length === 0
      ? 'Nothing is waiting for you.'
      : `**${pending.length} decision${pending.length === 1 ? '' : 's'} waiting for you.**`,
  );
  lines.push('', `Spent today: ${formatUsd(spentToday)}.`);
  return lines.join('\n');
}

/**
 * A pure read of settings and the ledger. Nothing here calls an engine,
 * checks a budget, or takes a lock — which is exactly why §17.2 says this
 * must work when the project is over budget, and why it does: there is
 * nothing in its path that a budget could stop.
 */
function budgetText(deps: SlashCommandDeps): string {
  const dailyMicros = getSetting(deps.db, 'budgets.dailyUsd');
  const reserveMicros = getSetting(deps.db, 'budgets.directorReserveUsd');
  const spentToday = getUsageSince(deps.db, localMidnightIso());
  const availableToOthers = dailyMicros - reserveMicros;

  const lines = [
    `Spent today: **${formatUsd(spentToday)}** of ${formatUsd(dailyMicros)}.`,
    '',
    'Limits in force:',
    `- Today, everything: ${formatUsd(dailyMicros)}`,
    `- Per project: ${formatUsd(getSetting(deps.db, 'budgets.projectUsd'))}`,
    `- Per task: ${formatUsd(getSetting(deps.db, 'budgets.perTaskUsd'))}`,
    `- Per employee per day: ${formatUsd(getSetting(deps.db, 'budgets.perEmployeeDailyUsd'))}`,
    '',
    // §11.5's carve-out, said plainly rather than left as a surprise: an
    // employee stops at (daily − reserve) so the Director always has
    // enough left to tell you what happened.
    `${formatUsd(reserveMicros)} of the daily limit is held back for the Director, so employees` +
      ` stop at ${formatUsd(availableToOthers)}. That is what keeps a spent budget from leaving` +
      ' you with nobody to talk to.',
  ];

  if (spentToday >= dailyMicros) {
    lines.push(
      '',
      "**Today's budget is gone.** Nothing more will run until you raise it or the day rolls over.",
    );
  } else if (spentToday >= availableToOthers) {
    lines.push(
      '',
      '**Employees have stopped for today** — only the Director’s reserve is left. Raise the daily' +
        ' limit to carry on.',
    );
  }
  return lines.join('\n');
}

/**
 * Company-wide, and it says so. `/pause` reads like a project-level
 * command and is not one — there is one company and this stops all of it.
 *
 * Uses the same `Supervisor.pause()` the `employees.pause` handler calls,
 * so there is one pause. The transition emits its own single event
 * (`employee.parked`), which is the state change; nothing extra is
 * emitted here, following `answerCheckpoint`'s rule that one state change
 * gets one event even when the taxonomy offers a second name for it.
 */
async function pauseEveryone(deps: SlashCommandDeps): Promise<string> {
  const registry = deps.supervisorRegistry;
  const live = registry?.all() ?? [];
  if (live.length === 0) {
    return 'Nobody is running, so there was nothing to pause.';
  }

  const paused: string[] = [];
  for (const { employeeId, supervisor } of live) {
    if (supervisor.currentState === 'off' || supervisor.currentState === 'parked') continue;
    await supervisor.pause();
    paused.push(employeeId);
  }

  if (paused.length === 0) {
    return 'Everyone was already stopped, so there was nothing to pause.';
  }

  const names = paused
    .map((id) => listEmployees(deps.db).find((e) => e.id === id)?.name ?? id)
    .join(', ');
  return [
    `Paused **everyone who was running, company-wide** — ${names}.`,
    '',
    'They will not take another turn until you resume them. **A pause outlives closing the app:',
    'reopening Bureau does not lift it.** Use Resume, above the message box, whenever you want',
    'them going again.',
  ].join('\n');
}

function planText(deps: SlashCommandDeps): string {
  const row = deps.db.prepare('SELECT id FROM plans ORDER BY created_at DESC LIMIT 1').get() as
    { id: string } | undefined;
  if (row === undefined) {
    return [
      'There is no plan yet.',
      '',
      'A plan comes from the Director, after you describe what you want built and approve a brief.',
      'No Director has been hired in this build, so nothing can draft one — the Board tab will',
      'show the phases and tasks once one exists.',
    ].join('\n');
  }
  return 'There is a plan. Open the Board tab to see its phases and tasks.';
}

function deliverText(deps: SlashCommandDeps): string {
  const row = deps.db
    .prepare('SELECT id FROM deliverables ORDER BY created_at DESC LIMIT 1')
    .get() as { id: string } | undefined;
  if (row === undefined) {
    return [
      'There is nothing to deliver yet.',
      '',
      'Deliverables are produced by employees working through an approved plan. Describe what you',
      'want built to get that started — though note that no Director has been hired in this build,',
      'so nothing will answer yet.',
    ].join('\n');
  }
  return 'There is at least one deliverable. Open it from the Board tab.';
}

/** Integer micro-dollars everywhere (invariant #12); this is the one place
 * this file turns one into a sentence. */
function formatUsd(micros: number): string {
  return `$${microsToUsd(micros).toFixed(2)}`;
}
