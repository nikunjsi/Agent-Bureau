import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { broadcastPatch, wireStateDeltaOnLoad } from '../../../src/main/ipc/stateDelta';
import { createElectronChatBroadcaster } from '../../../src/main/chat/electronChatBroadcaster';
import { emptyChatState, useBureauStore } from '../../../src/renderer/src/store/bureauStore';
import type { StateDelta } from '../../../src/shared/ipc/schemas/events';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * Two windows, one live producer — the case a single shared sequence
 * counter loses silently.
 *
 * `stateDelta.ts` allocated every sequence number from one module-level
 * counter, and asserted in a comment that this was safe "because a `full`
 * delta resets each renderer's own tracking". It is not, and M9 is the
 * milestone that makes it reachable: with two windows open, the second
 * window's snapshot consumes a number, and the next broadcast patch is
 * then one ahead of what the FIRST window expects. `applyDelta` drops it,
 * correctly, and then waits for a `full` delta that only ever arrives on a
 * page load. That window is stale until somebody reloads it, and nothing
 * anywhere says so.
 *
 * **What is real here and what is not.** The production `wireStateDeltaOnLoad`,
 * `broadcastPatch` and chat broadcaster all run — including the
 * `did-finish-load` handler that starts a window's sequences, which is
 * where the allocation actually happens, and the skip branch inside the
 * broadcast loop. Only the DESTINATION is substituted: a real
 * `BrowserWindow` needs a live Electron runtime vitest never has, so these
 * are objects carrying the `webContents.on`/`send` surface the real code
 * calls — exactly the substitution S4 makes for the same reason. The
 * renderer half is the real `bureauStore` reducer, not a restatement of it.
 */

interface FakeWindow {
  sent: { channel: string; payload: unknown }[];
  finishLoad: () => void;
  win: BrowserWindow;
}

function fakeWindow(): FakeWindow {
  const sent: { channel: string; payload: unknown }[] = [];
  let didFinishLoad: (() => void) | null = null;
  const win = {
    isDestroyed: () => false,
    webContents: {
      on: (event: string, cb: () => void) => {
        if (event === 'did-finish-load') didFinishLoad = cb;
      },
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  } as unknown as BrowserWindow;
  return {
    sent,
    win,
    finishLoad: () => {
      if (didFinishLoad === null) {
        throw new Error('wireStateDeltaOnLoad never registered a did-finish-load handler');
      }
      didFinishLoad();
    },
  };
}

const lastPayload = (w: FakeWindow, channel: string): unknown =>
  w.sent.filter((s) => s.channel === channel).at(-1)?.payload;

describe('pushed-event sequencing across two windows', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-pushseq-'));
    db = openConnection(path.join(tmpDir, 'bureau.db'));
    await runMigrations({
      db,
      dbPath: path.join(tmpDir, 'bureau.db'),
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    useBureauStore.setState({
      hydrated: false,
      lastAppliedSeq: 0,
      checkpoints: [],
      chat: emptyChatState(),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a patch broadcast after a second window loads still applies in the first', () => {
    const a = fakeWindow();
    const b = fakeWindow();
    wireStateDeltaOnLoad(a.win, db);
    wireStateDeltaOnLoad(b.win, db);

    // The real load event, twice — the thing that used to consume two
    // numbers from one counter.
    a.finishLoad();
    const snapshotForA = lastPayload(a, 'stateDelta') as StateDelta;
    b.finishLoad();
    expect(snapshotForA.seq).toBe(1);
    expect((lastPayload(b, 'stateDelta') as StateDelta).seq).toBe(1);

    broadcastPatch('checkpoints', [], [a.win, b.win]);

    const patchForA = lastPayload(a, 'stateDelta') as StateDelta;
    expect(patchForA.seq, 'window A must receive ITS OWN next sequence').toBe(2);
    expect((lastPayload(b, 'stateDelta') as StateDelta).seq).toBe(2);

    // And the real reducer accepts it, hydrated by window A's own real
    // snapshot. This is the half that was broken: the send always
    // happened; the apply is what silently did not.
    useBureauStore.getState().applyDelta(snapshotForA);
    expect(useBureauStore.getState().lastAppliedSeq).toBe(1);
    useBureauStore.getState().applyDelta(patchForA);
    expect(useBureauStore.getState().lastAppliedSeq).toBe(2);
  });

  it('skips a window that has not finished loading rather than inventing a sequence for it', () => {
    const loaded = fakeWindow();
    const neverLoaded = fakeWindow();
    wireStateDeltaOnLoad(loaded.win, db);
    wireStateDeltaOnLoad(neverLoaded.win, db);
    loaded.finishLoad();

    broadcastPatch('checkpoints', [], [loaded.win, neverLoaded.win]);

    expect(loaded.sent).toHaveLength(2); // its snapshot, then the patch
    // The branch: a window with no snapshot has nothing to apply a patch
    // on top of, and one is coming on `did-finish-load` regardless.
    expect(neverLoaded.sent).toHaveLength(0);
  });

  it('chat and state sequences are counted separately, per window', () => {
    const a = fakeWindow();
    wireStateDeltaOnLoad(a.win, db);
    a.finishLoad();
    const chat = createElectronChatBroadcaster(() => [a.win]);
    const message = { id: 'm1', conversation_id: 'c1' } as unknown as ConversationMessage;

    broadcastPatch('checkpoints', [], [a.win]);
    chat.messageChanged(message);
    chat.messageChanged(message);
    broadcastPatch('checkpoints', [], [a.win]);

    const chatSeqs = a.sent
      .filter((s) => s.channel === 'chatMessage')
      .map((s) => (s.payload as { seq: number }).seq);
    const deltaSeqs = a.sent
      .filter((s) => s.channel === 'stateDelta')
      .map((s) => (s.payload as StateDelta).seq);

    // Interleaving them on one counter would make every chat push look
    // like a stateDelta gap and vice versa — two channels applied to two
    // different stores cannot share one sequence.
    expect(chatSeqs).toEqual([1, 2]);
    expect(deltaSeqs).toEqual([1, 2, 3]);
  });
});
