import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * M11 S2-0, invariant #1: **every chat message a Core-side path posts is
 * pushed to an open window**, through the one `ChatBroadcaster` `main()`
 * builds.
 *
 * `appendChatMessage` falls back to the no-op broadcaster when its deps
 * carry none — right for a test, silent in production: the row is saved,
 * the event is written, and the window shows nothing until it next
 * re-hydrates. `bureau_report` did exactly that. So each call's first
 * argument must name the broadcaster, or be one of the deps builders
 * listed below, each of which does.
 */

/** A call whose deps come from a helper that already threads the broadcaster. */
const DEPS_BUILDERS_THAT_CARRY_IT: Record<string, string> = {
  // `chatDeps(ctx)` spreads `ctx.chatBroadcaster` (ipc/handlers/chat.ts).
  'chatDeps(ctx)': 'src/main/ipc/handlers/chat.ts',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (full.endsWith('.ts')) out.push(full.split(path.sep).join('/'));
  }
  return out;
}

/** The text of a call's first argument, found by bracket depth. */
function firstArgument(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen + 1; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) return source.slice(openParen + 1, i).trim();
      depth -= 1;
    } else if (c === ',' && depth === 0) return source.slice(openParen + 1, i).trim();
  }
  return '';
}

export function appendChatMessageCalls(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(/\bappendChatMessage\(/g)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const line = source.slice(lineStart, match.index);
    // Prose, the declaration, and imports are not calls.
    if (/^\s*(\*|\/\/)/.test(line) || /function\s+$/.test(line)) continue;
    calls.push(firstArgument(source, match.index + 'appendChatMessage'.length));
  }
  return calls;
}

function carriesTheBroadcaster(deps: string, file: string): boolean {
  return /broadcaster/i.test(deps) || DEPS_BUILDERS_THAT_CARRY_IT[deps] === file;
}

describe('every chat message written in src/ is pushed to the open window', () => {
  it('reads the deps of each call, and tells one that carries the broadcaster from one that does not', () => {
    const source = [
      'appendChatMessage({ db, activityLog }, { body });',
      'appendChatMessage({ db, broadcaster: deps.chatBroadcaster }, input);',
      ' * `appendChatMessage(deps, input)` in prose',
    ].join('\n');
    expect(appendChatMessageCalls(source)).toEqual([
      '{ db, activityLog }',
      '{ db, broadcaster: deps.chatBroadcaster }',
    ]);
    expect(carriesTheBroadcaster('{ db, activityLog }', 'x.ts')).toBe(false);
    expect(carriesTheBroadcaster('{ db, broadcaster: deps.chatBroadcaster }', 'x.ts')).toBe(true);
  });

  it("main() builds one broadcaster and hands it to the control channel's handlers", () => {
    // Checked at the source because main() only runs inside Electron. The
    // handler half is proved over the real channel in
    // directorCardsReachTheWindow.test.ts; this proves the shipped app
    // gives the channel the instance the renderer is listening on.
    const main = readFileSync('src/main/index.ts', 'utf8');
    expect(main.match(/createElectronChatBroadcaster\(\)/g)).toHaveLength(1);
    const server = /new ControlChannelServer\(\{[\s\S]*?\}\)/.exec(main)?.[0];
    expect(server).toMatch(/^\s*chatBroadcaster,\s*$/m);
    expect(main).toMatch(/reportDirectorStart\(\{[^}]*broadcaster: chatBroadcaster[^}]*\}/);
  });

  it('no call in src/ falls back to the silent no-op broadcaster', () => {
    const bypasses: string[] = [];
    let calls = 0;
    for (const file of walk('src')) {
      for (const deps of appendChatMessageCalls(readFileSync(file, 'utf8'))) {
        calls += 1;
        if (!carriesTheBroadcaster(deps, file)) {
          bypasses.push(`${file}: appendChatMessage(${deps.replace(/\s+/g, ' ')}, …)`);
        }
      }
    }
    // Every writer there is today; a scanner that finds none proves nothing.
    expect(calls).toBeGreaterThanOrEqual(7);
    expect(
      bypasses,
      'appendChatMessage without a broadcaster saves the message but never pushes it: the open ' +
        'window shows nothing until it re-hydrates. Pass the ChatBroadcaster main() builds.',
    ).toEqual([]);
  });
});
