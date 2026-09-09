import { create } from 'zustand';
import type { StateDelta } from '../../../shared/ipc/schemas/events';
import type { SettingsValues } from '../../../shared/settings/schema';
import type { Company } from '../../../shared/models/company';
import type { Project } from '../../../shared/models/project';
import type { Task } from '../../../shared/models/task';
import type { Employee } from '../../../shared/models/employee';
import type { Checkpoint } from '../../../shared/models/checkpoint';
import type { ConversationMessage } from '../../../shared/models/conversationMessage';

export type RightPanelTab = 'chat' | 'board' | 'checkpoints' | 'inspector';

/** What the chat view is currently doing. `resyncing` is not a spinner
 * state so much as an honesty state: a push was missed, so what is on
 * screen is not trusted until `chat.listMessages` answers. */
export type ChatStatus = 'idle' | 'loading' | 'resyncing' | 'ready' | 'error';

interface BureauState {
  /** `false` until the first `full` delta lands — every view's "loading"
   * vs. "genuinely empty" empty state reads this, not just an empty array
   * (an empty array before hydration would render "no projects yet" for
   * a fraction of a second on every launch, which is a lie). */
  hydrated: boolean;
  lastAppliedSeq: number;
  /** Bumped by every `full` delta. The chat view watches it and re-fetches
   * its messages: a full delta means the window (re)loaded or reconnected,
   * and chat lives on its own channel that knows nothing about that. */
  hydrationEpoch: number;
  settings: SettingsValues | null;
  company: Company | null;
  projects: Project[];
  tasks: Task[];
  employees: Employee[];
  checkpoints: Checkpoint[];

  activeTab: RightPanelTab;
  setActiveTab: (tab: RightPanelTab) => void;

  /**
   * ## The chat slice, and the two rules it must not break
   *
   * **1. Nothing here is authoritative** (§17.2, invariant #11). Every
   * message in this array came from the Core, and is replaced by what the
   * Core sends. There are **no optimistic appends**: a message the renderer
   * believes in and the Core does not is not a UI glitch, it is data loss
   * wearing a UI glitch's clothes. The composer (session 2) sends and waits
   * for the row to come back like everything else.
   *
   * **2. A missed push is assumed, not hoped against.** Every `chatMessage`
   * carries a per-window channel sequence. If one arrives out of order,
   * something was dropped, and what is on screen may be wrong in the worst
   * available way — a message stuck rendering as mid-stream while the Core
   * long since finished it. So a gap does not patch, it **re-fetches** the
   * conversation through `chat.listMessages`. Pushes that arrive while that
   * request is in flight are buffered and replayed after it, because
   * upsert-by-id is idempotent but dropping is not.
   *
   * This is not polling (§17.2): nothing here runs on a timer. A fetch
   * happens on a window load, on a conversation change, or on a detected
   * gap.
   */
  chat: {
    conversationId: string | null;
    messages: ConversationMessage[];
    status: ChatStatus;
    /** The last channel seq applied. `null` before the first push. */
    lastChannelSeq: number | null;
    /** True while a re-fetch is in flight; pushes queue rather than apply. */
    resyncing: boolean;
    /** Pushes that arrived mid-resync, in arrival order. */
    buffered: { seq: number; message: ConversationMessage }[];
  };

  /** Called when a conversation is selected, before any fetch. */
  beginChatLoad: (conversationId: string) => void;
  /** The authoritative answer from `chat.listMessages`. Replaces; never
   * merges. Buffered pushes are replayed on top, in order. */
  hydrateChat: (conversationId: string, messages: ConversationMessage[]) => void;
  chatLoadFailed: (conversationId: string) => void;
  /**
   * One pushed message. Returns whether the caller must re-fetch: `true`
   * means a gap was detected and this store has deliberately not applied
   * anything it cannot place.
   */
  applyChatMessage: (seq: number, message: ConversationMessage) => boolean;

  /** §17.2 semantics, applied exactly as specified: a `full` delta
   * replaces every slice and resets the seq counter; a `patch` applies
   * only if its `seq` is exactly `lastAppliedSeq + 1` — anything else
   * (a gap, or arriving before the first `full`) is dropped, not
   * applied out of order, and logged so drift is visible rather than
   * silent. See schemas/events.ts for why this shape was chosen. */
  applyDelta: (delta: StateDelta) => void;
}

export const emptyChatState = (): BureauState['chat'] => ({
  conversationId: null,
  messages: [],
  status: 'idle',
  lastChannelSeq: null,
  resyncing: false,
  buffered: [],
});

/** Newest last, matching `chat.listMessages`' own `ORDER BY created_at`.
 * `id` breaks a tie: two rows written in the same millisecond still have a
 * stable order, and ULIDs sort by creation time anyway. */
function byCreatedAt(a: ConversationMessage, b: ConversationMessage): number {
  if (a.created_at === b.created_at) return a.id < b.id ? -1 : 1;
  return a.created_at < b.created_at ? -1 : 1;
}

function upsert(
  messages: ConversationMessage[],
  message: ConversationMessage,
): ConversationMessage[] {
  const index = messages.findIndex((m) => m.id === message.id);
  if (index === -1) return [...messages, message].sort(byCreatedAt);
  const next = [...messages];
  next[index] = message;
  return next;
}

export const useBureauStore = create<BureauState>((set, get) => ({
  hydrated: false,
  lastAppliedSeq: 0,
  hydrationEpoch: 0,
  settings: null,
  company: null,
  projects: [],
  tasks: [],
  employees: [],
  checkpoints: [],

  activeTab: 'chat', // §14.1: "Chat is the default tab on every launch."
  setActiveTab: (tab) => set({ activeTab: tab }),

  chat: emptyChatState(),

  beginChatLoad: (conversationId) =>
    set((state) => {
      const sameConversation = state.chat.conversationId === conversationId;
      return {
        chat: {
          ...emptyChatState(),
          conversationId,
          // A re-fetch of the conversation already on screen keeps what is
          // showing and says `resyncing`; a genuinely different conversation
          // starts empty and says `loading`. Blanking the screen to re-check
          // something the user is reading is its own small lie.
          messages: sameConversation ? state.chat.messages : [],
          status: sameConversation ? 'resyncing' : 'loading',
          resyncing: true,
          // **The buffer survives this call.** A gap is detected in
          // `applyChatMessage`, which buffers the message it could not
          // place and asks for a re-fetch — and the re-fetch begins here.
          // Clearing the buffer would drop precisely the message that
          // revealed the problem. (The re-fetch would almost always carry
          // it anyway, since it is committed before it is pushed — but
          // "almost always" is not what the doc comment above promises,
          // and a promise that holds by luck is not one.) A switch to a
          // different conversation drops it, because it belongs to the
          // conversation being left.
          buffered: sameConversation ? state.chat.buffered : [],
        },
      };
    }),

  hydrateChat: (conversationId, messages) =>
    set((state) => {
      // A response for a conversation the user has since navigated away
      // from must not overwrite the one they are looking at.
      if (state.chat.conversationId !== conversationId) return {};
      let next = [...messages].sort(byCreatedAt);
      let lastChannelSeq = state.chat.lastChannelSeq;
      for (const buffered of state.chat.buffered) {
        if (buffered.message.conversation_id !== conversationId) continue;
        next = upsert(next, buffered.message);
        lastChannelSeq = buffered.seq;
      }
      return {
        chat: {
          conversationId,
          messages: next,
          status: 'ready',
          lastChannelSeq,
          resyncing: false,
          buffered: [],
        },
      };
    }),

  chatLoadFailed: (conversationId) =>
    set((state) =>
      state.chat.conversationId === conversationId
        ? { chat: { ...state.chat, status: 'error', resyncing: false, buffered: [] } }
        : {},
    ),

  applyChatMessage: (seq, message) => {
    const state = get();
    const chat = state.chat;

    if (chat.resyncing) {
      set({ chat: { ...chat, buffered: [...chat.buffered, { seq, message }] } });
      return false;
    }

    // A gap. Something was dropped, and this store cannot know what — it
    // could be an insert (a message missing) or a terminal flush (a message
    // frozen mid-stream). Both need the same answer: ask the Core.
    if (chat.lastChannelSeq !== null && seq !== chat.lastChannelSeq + 1) {
      console.warn(
        `[chatMessage] sequence gap: expected ${chat.lastChannelSeq + 1}, got ${seq}. Re-fetching the conversation.`,
      );
      set({
        chat: { ...chat, status: 'resyncing', resyncing: true, buffered: [{ seq, message }] },
      });
      return true;
    }

    // Not this conversation: the sequence is still consumed (it is a
    // per-window channel, not a per-conversation one), but there is nothing
    // to apply. Dropping the seq instead would manufacture a gap on the
    // next message that *is* ours.
    if (chat.conversationId !== message.conversation_id) {
      set({ chat: { ...chat, lastChannelSeq: seq } });
      return false;
    }

    set({
      chat: { ...chat, messages: upsert(chat.messages, message), lastChannelSeq: seq },
    });
    return false;
  },

  applyDelta: (delta) => {
    if (delta.kind === 'full') {
      set((state) => ({
        hydrated: true,
        lastAppliedSeq: delta.seq,
        hydrationEpoch: state.hydrationEpoch + 1,
        settings: (delta.slices.settings as SettingsValues | undefined) ?? null,
        company: (delta.slices.company as Company | null | undefined) ?? null,
        projects: (delta.slices.projects as Project[] | undefined) ?? [],
        tasks: (delta.slices.tasks as Task[] | undefined) ?? [],
        employees: (delta.slices.employees as Employee[] | undefined) ?? [],
        checkpoints: (delta.slices.checkpoints as Checkpoint[] | undefined) ?? [],
      }));
      return;
    }

    const state = get();
    if (!state.hydrated || delta.seq !== state.lastAppliedSeq + 1) {
      console.warn(
        `[stateDelta] dropped a "${delta.slice}" patch (seq ${delta.seq}) — expected ${state.hydrated ? state.lastAppliedSeq + 1 : 'a full delta first'}. Waiting for the next full delta.`,
      );
      return;
    }
    set({ lastAppliedSeq: delta.seq, [delta.slice]: delta.value });
  },
}));
