import { useEffect, useState } from 'react';

import { peerLabel } from '../messaging/hooks';
import { getConversation } from '../messaging/messageStore';
import { useChatLockStore } from '../security/chatLock';
import { useCallLogStore } from './callHistory';

/**
 * Who the call screen may say is on the line. The name is the local nickname (never sent
 * anywhere). If the conversation with this person is LOCKED and no Chat Lock unlock session is
 * active, nothing identifying is shown: no name, no avatar initial. The person can still answer
 * or decline; "Unlock to see caller" authenticates first.
 *
 * @returns {{ ready: boolean, hidden: boolean, name: string, title: string | null }}
 */
export function useCallPeer(peerUserId) {
  const unlocked = useChatLockStore((state) => state.unlocked);
  // Re-read when the call engine creates or names this person's chat (see rememberPeer).
  const revision = useCallLogStore((state) => state.revision);
  const [conversation, setConversation] = useState({
    loaded: false,
    title: null,
    phone: null,
    locked: true,
  });

  useEffect(() => {
    if (!peerUserId) return undefined;
    let cancelled = false;
    getConversation(peerUserId).then(
      (row) =>
        !cancelled &&
        setConversation({
          loaded: true,
          title: row?.title ?? null,
          phone: row?.peerPhone ?? null,
          locked: row?.locked === 1,
        }),
      // Unreadable: fail closed (treat as locked).
      () => !cancelled && setConversation({ loaded: true, title: null, locked: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [peerUserId, revision]);

  const hidden = !conversation.loaded || (conversation.locked && !unlocked);
  return {
    ready: conversation.loaded,
    hidden,
    name: hidden
      ? 'CipherChat call'
      : peerLabel(peerUserId, conversation.title, conversation.phone),
    title: hidden ? null : conversation.title,
  };
}
