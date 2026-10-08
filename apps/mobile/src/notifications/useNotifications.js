import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';

import { requestSync } from '../messaging/messagingEngine';
import { onTapQueued, processPendingTaps } from './notificationRouting';
import { registerForPushNotifications, watchPushTokenChanges } from './pushNotifications';

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
    // A push received while open: Pusher normally got there first; sync just in case.
    const received = Notifications.addNotificationReceivedListener(() => requestSync());
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
