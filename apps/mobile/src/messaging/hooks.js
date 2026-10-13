import { useEffect, useState } from 'react';

import { listCallLog, listPeerCalls, useCallLogStore } from '../calls/callHistory';
import { getPendingIdentityChange, listIdentityChanges } from '../crypto/signalService';
import { formatPhone } from '../lib/phone';
import { useMediaStore } from '../media/attachmentService';
import {
  getConversation,
  listChatMessages,
  listConversations,
  lockedChatsSummary,
} from './messageStore';
import { useMessagingStore } from './messagingEngine';

/**
 * Re-reads `load()` from the encrypted database whenever local messaging data or the call
 * history changes.
 */
function useLocalQuery(load, deps) {
  const revision = useMessagingStore((state) => state.revision);
  const callRevision = useCallLogStore((state) => state.revision);
  const mediaRevision = useMediaStore((state) => state.revision);
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
  }, [revision, callRevision, mediaRevision, ...deps]);

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

/**
 * One conversation: its messages, plus its security state. `identityChange` is the undecided
 * change of the contact's security code (or null); `identityEvents` are past and pending
 * changes, and `calls` the voice calls with this person, all shown in the chat timeline.
 */
export function useChat(peerUserId) {
  return useLocalQuery(
    async () => ({
      conversation: await getConversation(peerUserId),
      messages: await listChatMessages(peerUserId),
      identityChange: await getPendingIdentityChange(peerUserId),
      identityEvents: await listIdentityChanges(peerUserId),
      calls: await listPeerCalls(peerUserId),
    }),
    [peerUserId],
  );
}

/** This phone's call history, newest first (each row says whether its chat is locked). */
export function useCallLog() {
  return useLocalQuery(listCallLog, []);
}

/**
 * Display name for a peer: the local name (contact name or nickname), else their phone number
 * (known once they have messaged us), else a short form of their user ID.
 */
export function peerLabel(peerUserId, title, phone = null) {
  return title || (phone ? formatPhone(phone) : null) || `User …${String(peerUserId).slice(-6)}`;
}
