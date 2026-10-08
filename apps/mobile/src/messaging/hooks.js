import { useEffect, useState } from 'react';

import {
  getConversation,
  listChatMessages,
  listConversations,
  lockedChatsSummary,
} from './messageStore';
import { useMessagingStore } from './messagingEngine';

/** Re-reads `load()` from the encrypted database whenever local messaging data changes. */
function useLocalQuery(load, deps) {
  const revision = useMessagingStore((state) => state.revision);
  const [state, setState] = useState({ data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => !cancelled && setState({ data, error: null }),
      (error) => !cancelled && setState((s) => ({ data: s.data, error })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are passed by the caller
  }, [revision, ...deps]);

  return state;
}

/** Unlocked conversations only (locked ones are listed by useLockedConversations). */
export function useConversations() {
  return useLocalQuery(listConversations, []);
}

/** Locked conversations. Only call when a Chat Lock unlock session is active. */
export function useLockedConversations(enabled) {
  return useLocalQuery(async () => (enabled ? listConversations({ locked: true }) : []), [enabled]);
}

/** Whether locked chats exist / have unread messages (no names, previews or counts). */
export function useLockedChatsSummary() {
  return useLocalQuery(lockedChatsSummary, []);
}

/** Total unread incoming messages (tab badge). */
export function useUnreadTotal() {
  const { data } = useConversations();
  return (data ?? []).reduce((sum, c) => sum + (c.unread ?? 0), 0);
}

export function useChat(peerUserId) {
  return useLocalQuery(
    async () => ({
      conversation: await getConversation(peerUserId),
      messages: await listChatMessages(peerUserId),
    }),
    [peerUserId],
  );
}

/** Display name for a peer: local nickname, else a short form of their user ID. */
export function peerLabel(peerUserId, title) {
  return title || `User …${String(peerUserId).slice(-6)}`;
}
