import { describe, expect, it } from 'vitest';
import { parseSlashCommand } from '../../../src/main/chat/slashCommands';
import { SLASH_COMMANDS } from '../../../src/shared/chat/slashCommands';

/**
 * §17.2's parse, as a pure decision.
 *
 * **This test proves the parse and nothing else.** It does not prove
 * §17.2's actual requirement — that `/pause`, `/budget` and `/status` work
 * when the Director is mid-generation or out of budget — because a parser
 * cannot. That is
 * `tests/integration/chat/slashCommandsLive.test.ts`, which issues
 * `/pause` with a real stream live and `/budget` with the ledger genuinely
 * over the daily limit. Named here so the split is deliberate rather than
 * looking like coverage it is not (standing rule 1).
 */
describe('slash command parsing (§17.2)', () => {
  it('recognises all six, and only these six exist', () => {
    expect([...SLASH_COMMANDS]).toEqual(['status', 'pause', 'budget', 'plan', 'deliver', 'help']);
    for (const command of SLASH_COMMANDS) {
      expect(parseSlashCommand(`/${command}`)).toBe(command);
    }
  });

  it('ignores surrounding whitespace and case', () => {
    expect(parseSlashCommand('  /status  ')).toBe('status');
    expect(parseSlashCommand('/STATUS')).toBe('status');
    expect(parseSlashCommand('/Pause')).toBe('pause');
    expect(parseSlashCommand('/help\n')).toBe('help');
  });

  /**
   * §17.2: "Unrecognised slashes are passed through as ordinary text." The
   * two cases below are the ones that matter, and the second is why the
   * rule is whole-body-exact rather than first-token:
   */
  describe('passes through as ordinary text', () => {
    it('a path in a sentence', () => {
      expect(parseSlashCommand('/tmp/foo.log')).toBeNull();
      expect(parseSlashCommand('check /tmp/foo.log for the error')).toBeNull();
      expect(parseSlashCommand('/usr/local/bin')).toBeNull();
    });

    it('a command name followed by a sentence — it takes no arguments, so it is not one', () => {
      // A first-token match would have swallowed this into `/help`, and
      // the user's actual question would have vanished into a help
      // listing. None of the six takes an argument, so there is nothing
      // to lose by requiring the body to be exactly the command.
      expect(parseSlashCommand('/help me understand the plan')).toBeNull();
      expect(parseSlashCommand('/status of the login work?')).toBeNull();
    });

    it('a near-miss name', () => {
      expect(parseSlashCommand('/statuses')).toBeNull();
      expect(parseSlashCommand('/paus')).toBeNull();
      expect(parseSlashCommand('//status')).toBeNull();
    });

    it('anything not starting with a slash', () => {
      expect(parseSlashCommand('status')).toBeNull();
      expect(parseSlashCommand('Build me a recipe site')).toBeNull();
      expect(parseSlashCommand('')).toBeNull();
    });
  });
});
