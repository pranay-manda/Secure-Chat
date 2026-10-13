import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';

import { reconcileCall } from '../calls/callEngine';
import { requestSync } from '../messaging/messagingEngine';
import { onTapQueued, processPendingTaps } from './notificationRouting';
import {
  callIdFromNotification,
  registerForPushNotifications,
  watchPushTokenChanges,
} from './pushNotifications';

/**
 * A push received while the app is open (P5). Pusher normally got there first; sync just in
 * case. An incoming-call push whose realtime invite was lost would otherwise never ring (its
 * banner is suppressed in the foreground): ask the server, through the authenticated
 * current-call endpoint, and ring only if it confirms a call ringing for this device. The push
 * payload itself is never taken as call state.
 */
export function onForegroundNotification(notification) {
  requestSync();
  if (callIdFromNotification(notification)) reconcileCall().catch(() => {});
}

/**
 * Push notification wiring for the signed-in app.
 *
 * @param {boolean} messagingReady messaging started (keys registered), so the token registration
 *   is authenticated and a tapped message can be synced and decrypted
 * @param {boolean} navigationReady the root navigator is mounted, so routing will not be dropped
 */
export function useNotifications(messagingReady, navigationReady) {
  useEffect(() => {
    if (!messagingReady) return undefined;
    registerForPushNotifications();
    const stopWatching = watchPushTokenChanges();
    const received = Notifications.addNotificationReceivedListener(onForegroundNotification);
    return () => {
      stopWatching();
      received.remove();
    };
  }, [messagingReady]);

  // Taps (cold start and warm) are queued by notificationRouting from app launch; open them
  // once everything they need is ready, and again whenever a new tap is queued.
  useEffect(() => {
    if (!messagingReady || !navigationReady) return undefined;
    processPendingTaps();
    return onTapQueued(() => processPendingTaps());
  }, [messagingReady, navigationReady]);
}
