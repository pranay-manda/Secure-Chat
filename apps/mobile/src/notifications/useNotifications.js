import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';

import { findPeerByServerMessageId } from '../messaging/messageStore';
import { requestSync } from '../messaging/messagingEngine';
import {
  messageIdFromNotification,
  registerForPushNotifications,
  watchPushTokenChanges,
} from './pushNotifications';

/** Taps already handled in this JS session (cold-start responses are reported again). */
const handledTaps = new Set();

/**
 * Opens the conversation a tapped notification belongs to. The notification only holds an
 * opaque message id: sync first (fetch + decrypt the envelope locally), then look up which
 * conversation that message is in. Falls back to the chat list.
 */
export async function openFromNotification(response) {
  const id = response?.notification?.request?.identifier;
  const messageId = messageIdFromNotification(response?.notification);
  if (!messageId || (id && handledTaps.has(id))) return null;
  if (id) handledTaps.add(id);

  await requestSync().catch(() => {});
  const peer = await findPeerByServerMessageId(messageId).catch(() => null);
  router.push(peer ? `/chat/${peer}` : '/');
  return peer;
}

/**
 * Push notification wiring for the signed-in app. `ready` = messaging started (keys
 * registered), so a tap can be resolved and the token registration is authenticated.
 */
export function useNotifications(ready) {
  const lastResponse = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!ready) return undefined;
    registerForPushNotifications();
    const stopWatching = watchPushTokenChanges();
    // A push received while open: Pusher normally got there first; sync just in case.
    const received = Notifications.addNotificationReceivedListener(() => requestSync());
    return () => {
      stopWatching();
      received.remove();
    };
  }, [ready]);

  // Taps, including the one that launched the app from a killed state.
  useEffect(() => {
    if (ready && lastResponse) openFromNotification(lastResponse);
  }, [ready, lastResponse]);
}
