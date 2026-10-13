import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';

import { openCallFromNotification } from '../calls/callEngine';
import { findPeerByServerMessageId } from '../messaging/messageStore';
import { requestSync } from '../messaging/messagingEngine';
import { callIdFromNotification, messageIdFromNotification } from './pushNotifications';

/**
 * Notification-tap routing. One path for every tap:
 *
 *  - cold start (app was closed): the response that launched the app, read once at startup
 *    with getLastNotificationResponse()
 *  - warm (app running or in the background): addNotificationResponseReceivedListener
 *
 * Taps are queued here immediately (the app may still be restoring the session, starting
 * messaging or mounting the navigator) and processed only once the caller says everything is
 * ready. Each notification is handled at most once, keyed by its request identifier, even if
 * the platform reports it through both channels or the app re-renders.
 *
 * Only the opaque message id from the notification is used: the app syncs the encrypted
 * envelope over HTTPS, decrypts it locally, then finds which conversation it belongs to.
 */

const pending = [];
const handled = new Set();
const subscribers = new Set();
let started = false;

function notifySubscribers() {
  for (const fn of subscribers) fn();
}

/** Queues a tap unless it was already queued or handled. Returns true if queued. */
export function captureResponse(response) {
  const notification = response?.notification;
  const messageId = messageIdFromNotification(notification);
  const callId = callIdFromNotification(notification);
  if (!messageId && !callId) return false;
  const id =
    notification?.request?.identifier ?? (callId ? `call:${callId}` : `message:${messageId}`);
  if (handled.has(id) || pending.some((tap) => tap.id === id)) return false;
  pending.push(callId ? { id, callId } : { id, messageId });
  notifySubscribers();
  return true;
}

/**
 * Starts capturing taps. Call once, as early as possible (root layout module scope), so the
 * launch response is not missed. Idempotent.
 */
export function startNotificationCapture() {
  if (started) return;
  started = true;
  try {
    captureResponse(Notifications.getLastNotificationResponse());
  } catch {
    // Not available on this platform/build: warm taps still work through the listener.
  }
  Notifications.addNotificationResponseReceivedListener(captureResponse);
}

/** Subscribe to "a new tap was queued" (used to trigger processing). */
export function onTapQueued(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function hasPendingTaps() {
  return pending.length > 0;
}

let processing = null;

/**
 * Opens the conversation for each queued tap. Must only be called when the user is signed in,
 * messaging has started and the navigator is mounted. Concurrent calls share one run.
 */
export function processPendingTaps() {
  processing ??= (async () => {
    while (pending.length > 0) {
      const tap = pending.shift();
      handled.add(tap.id);
      if (tap.callId) {
        // Incoming call: ask the server whether it still rings for THIS signed-in device (a
        // call for a previous account is never shown). If it does, the call screen opens.
        const ringing = await openCallFromNotification(tap.callId).catch(() => false);
        if (ringing) router.push('/call');
        continue;
      }
      // Existing encrypted flow: fetch envelope over HTTPS, decrypt locally, store in SQLCipher.
      await requestSync().catch(() => {});
      const peer = await findPeerByServerMessageId(tap.messageId).catch(() => null);
      router.push(peer ? `/chat/${peer}` : '/');
    }
    // The launch response is kept natively until cleared; clear it so a later re-mount or
    // re-read can never replay an old tap.
    try {
      Notifications.clearLastNotificationResponse();
    } catch {
      // Best effort.
    }
  })().finally(() => {
    processing = null;
  });
  return processing;
}

/** Forgets queued taps (logout: a tap meant for the previous account must not be replayed). */
export function clearPendingTaps() {
  pending.length = 0;
}
