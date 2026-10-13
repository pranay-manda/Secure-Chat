import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { ENDPOINTS } from '../config/endpoints';
import { apiRequest } from '../lib/api';
import { useMessagingStore } from '../messaging/messagingEngine';

/** Active typing store: peerUserId -> boolean */
export const useTypingStore = create((set) => ({
  typingByUserId: {},
  setTyping: (userId, isTyping) =>
    set((state) => ({
      typingByUserId: { ...state.typingByUserId, [userId]: isTyping },
    })),
}));

const typingTimers = new Map();

/** Handles incoming Pusher typing event from a peer. */
export function handleTypingEvent(payload) {
  const fromUserId = payload?.fromUserId;
  const typing = Boolean(payload?.typing);
  if (!fromUserId) return;

  if (typingTimers.has(fromUserId)) {
    clearTimeout(typingTimers.get(fromUserId));
    typingTimers.delete(fromUserId);
  }

  const store = useTypingStore.getState();
  if (typing) {
    store.setTyping(fromUserId, true);
    // WhatsApp-style auto-clear after 3.5 seconds of inactivity
    const timer = setTimeout(() => {
      store.setTyping(fromUserId, false);
      typingTimers.delete(fromUserId);
    }, 3500);
    typingTimers.set(fromUserId, timer);
  } else {
    store.setTyping(fromUserId, false);
  }
}

/** Hook for whether a specific contact is currently typing. */
export function usePeerTyping(peerUserId) {
  return useTypingStore((state) => Boolean(state.typingByUserId[peerUserId]));
}

let lastTypingSentTime = 0;
let lastTypingPeer = null;

/** Sends a throttled typing ping to the server (max 1 per 2.5 seconds). */
export async function sendTypingPing(peerUserId, typing = true) {
  if (!peerUserId) return;
  const now = Date.now();
  if (typing && lastTypingPeer === peerUserId && now - lastTypingSentTime < 2500) {
    return;
  }
  lastTypingSentTime = now;
  lastTypingPeer = peerUserId;
  try {
    await apiRequest('POST', ENDPOINTS.PRESENCE.TYPING, {
      body: { peerUserId, typing },
    });
  } catch {
    // Best effort, ignored
  }
}

/**
 * Last known online status per user: `{ [userId]: boolean }`. Written by pushed presence events
 * (handlePresenceEvent) and by the chat header's polls; read by usePeerOnline.
 */
export const usePresenceStore = create(() => ({ onlineByUserId: {} }));

const setOnline = (userId, online) =>
  usePresenceStore.setState((s) =>
    s.onlineByUserId[userId] === online
      ? s
      : { onlineByUserId: { ...s.onlineByUserId, [userId]: online } },
  );

/** A pushed change (REALTIME_EVENT.PRESENCE `{ userId, online }`) from the server. */
export function handlePresenceEvent(payload) {
  if (typeof payload?.userId !== 'string' || typeof payload.online !== 'boolean') return;
  setOnline(payload.userId, payload.online);
  // Someone who went away is not typing any more.
  if (!payload.online) useTypingStore.getState().setTyping(payload.userId, false);
}

/** Forgets all known statuses (sign-out). */
export function resetPresence() {
  usePresenceStore.setState({ onlineByUserId: {} });
}

/** Re-reads presence this often while a chat is open (catches connections that vanished). */
export const PRESENCE_POLL_MS = 10_000;

/**
 * Whether the other person's app is online (their device heartbeats; see the API's
 * presenceService). This is app connectivity, not whether they are looking at their phone.
 *
 * Changes are pushed by the server when the other app comes online or goes away, so the header
 * updates at once. A poll every PRESENCE_POLL_MS (and whenever this app returns to the screen)
 * catches a connection that vanished without saying so (the server forgets it after its TTL).
 * A single "offline" answer counts: the server already tolerates one missed heartbeat.
 *
 * @returns {boolean|null} null until known
 */
export function usePeerOnline(peerUserId) {
  const online = useMessagingStore((state) => state.online);
  const known = usePresenceStore((state) => state.onlineByUserId[peerUserId]);

  useEffect(() => {
    if (!peerUserId || !online) return undefined;
    let cancelled = false;
    const read = async () => {
      const appState = AppState.currentState;
      if (appState === 'background' || appState === 'inactive') return; // nobody is looking
      try {
        const { presence } = await apiRequest('GET', ENDPOINTS.PRESENCE.query([peerUserId]));
        if (!cancelled) setOnline(peerUserId, presence?.[peerUserId] === true);
      } catch {
        // Offline or the request failed: keep what we knew.
      }
    };
    read();
    const timer = setInterval(read, PRESENCE_POLL_MS);
    // Back on screen: what we showed before may be old, read again now.
    const sub = AppState.addEventListener('change', (state) => state === 'active' && read());
    return () => {
      cancelled = true;
      clearInterval(timer);
      sub.remove();
    };
  }, [peerUserId, online]);

  return online ? (known ?? null) : null;
}
