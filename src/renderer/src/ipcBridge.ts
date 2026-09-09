import { ChatMessageEventSchema, StateDeltaSchema } from '../../shared/ipc/schemas/events';
import { useBureauStore } from './store/bureauStore';

/**
 * Subscribes to the pushed channels and pipes validated payloads into the
 * store. The preload is a thin pass-through with no Zod (§17.3) — this is
 * where "every IPC payload... is validated" (§4.2) actually happens for
 * *pushed* events, the renderer-side equivalent of what the main-side
 * router does for `invoke` calls. Only each event's own envelope shape is
 * validated here, not each slice's deep model shape — main is the same
 * trusted process that already validated those via M1's repositories
 * before ever building the payload.
 *
 * Returns one unsubscribe function that tears down every subscription, for
 * symmetry / so a future multi-window scenario can do it per-window.
 */
export function wireIpcBridge(): () => void {
  const unsubscribeStateDelta = window.bureau.on.stateDelta((payload) => {
    const parsed = StateDeltaSchema.safeParse(payload);
    if (!parsed.success) {
      console.error('[stateDelta] dropped a malformed delta', parsed.error.issues);
      return;
    }
    useBureauStore.getState().applyDelta(parsed.data);
  });

  const unsubscribeChatMessage = window.bureau.on.chatMessage((payload) => {
    const parsed = ChatMessageEventSchema.safeParse(payload);
    if (!parsed.success) {
      console.error('[chatMessage] dropped a malformed message', parsed.error.issues);
      return;
    }
    const { seq, message } = parsed.data;
    // `true` means the store detected a sequence gap and refused to apply
    // something it cannot place. The recovery is a re-fetch of the
    // authoritative list; the store has already buffered this message so
    // nothing is lost while that is in flight.
    const needsResync = useBureauStore.getState().applyChatMessage(seq, message);
    if (needsResync) void refetchConversation(message.conversation_id);
  });

  return () => {
    unsubscribeStateDelta();
    unsubscribeChatMessage();
  };
}

/**
 * Re-fetch a conversation from the Core. Exported so the chat view uses the
 * same call on load and on conversation change — one function, so "what
 * does this view believe" has one answer regardless of what triggered the
 * fetch (standing rule 6).
 */
export async function refetchConversation(conversationId: string): Promise<void> {
  const store = useBureauStore.getState();
  store.beginChatLoad(conversationId);
  const result = await window.bureau.chat.listMessages({ conversationId });
  if (!result.ok) {
    console.error('[chat] listMessages failed', result.error);
    useBureauStore.getState().chatLoadFailed(conversationId);
    return;
  }
  useBureauStore.getState().hydrateChat(conversationId, result.data.items);
}
