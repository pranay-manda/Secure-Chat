import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { create } from 'zustand';

import { ENDPOINTS } from '../config/endpoints';
import { apiRequest } from '../lib/api';
import { deleteSecureItem, getSecureJson, SECURE_KEYS, setSecureJson } from '../lib/secureStorage';

/**
 * Push notifications (Expo push service -> FCM V1 on Android). A notification only says
 * "New message" and carries an opaque message id: the app then syncs the encrypted envelope
 * over HTTPS and decrypts it locally. Nothing here ever touches message content or keys.
 *
 * Every function is best effort: notification problems must never break messaging, which
 * keeps working through Pusher and sync.
 */

export const MESSAGES_CHANNEL_ID = 'messages';
/** Incoming voice calls: highest importance so a ringing call is not silently collapsed. */
export const CALLS_CHANNEL_ID = 'calls';
/** Re-register a known token at least this often (server may have dropped it). */
const REREGISTER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** status: unknown | granted | denied | unavailable | error */
export const usePushStore = create(() => ({ status: 'unknown', error: null }));

// While the app is open Pusher delivers messages live, so a push that still arrives (e.g. ack
// raced the push) is not shown as a banner; the app just syncs.
Notifications.setNotificationHandler({
  handleNotification: async () => {
    const foreground = AppState.currentState === 'active';
    return {
      shouldShowBanner: !foreground,
      shouldShowList: !foreground,
      shouldPlaySound: !foreground,
      shouldSetBadge: false,
    };
  },
});

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL_ID, {
    name: 'Messages',
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    showBadge: true,
  });
  await Notifications.setNotificationChannelAsync(CALLS_CHANNEL_ID, {
    name: 'Calls',
    importance: Notifications.AndroidImportance.MAX,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    vibrationPattern: [0, 500, 500, 500],
    showBadge: false,
  });
}

/** Asks for permission only when it can still be asked (Android 13+ shows a system prompt). */
async function ensurePermission() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

function projectId() {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

/**
 * Gets this install's push token and registers it with the API (only when it changed or is
 * old). Safe to call on every app start and on token refresh.
 *
 * @returns {Promise<'granted'|'denied'|'unavailable'|'error'>}
 */
let registrationInFlight = null;
export function registerForPushNotifications(options) {
  // Single-flight: concurrent callers (start, token listener, settings) share one attempt.
  registrationInFlight ??= register(options).finally(() => {
    registrationInFlight = null;
  });
  return registrationInFlight;
}

async function register({ force = false } = {}) {
  try {
    await ensureAndroidChannel();
    if (!(await ensurePermission())) {
      usePushStore.setState({ status: 'denied', error: null });
      return 'denied';
    }
    if (!projectId()) {
      usePushStore.setState({ status: 'unavailable', error: 'NO_PROJECT_ID' });
      return 'unavailable';
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: projectId() });
    const stored = await getSecureJson(SECURE_KEYS.PUSH_REGISTRATION);
    const fresh =
      stored?.token === token && Date.now() - (stored.registeredAt ?? 0) < REREGISTER_AFTER_MS;
    if (force || !fresh) {
      await apiRequest('POST', ENDPOINTS.DEVICES.PUSH_TOKEN, { body: { token } });
      await setSecureJson(SECURE_KEYS.PUSH_REGISTRATION, { token, registeredAt: Date.now() });
    }
    usePushStore.setState({ status: 'granted', error: null });
    return 'granted';
  } catch (err) {
    // Offline, API down, or no Google Play services: retried on the next start/refresh.
    usePushStore.setState({ status: 'error', error: err?.code ?? err?.message ?? 'ERROR' });
    return 'error';
  }
}

/** Device (FCM) token values already seen in this JS session. */
const seenDeviceTokens = new Set();

/**
 * Re-registers when FCM rotates the device token. Returns an unsubscribe function.
 *
 * expo-notifications also fires this listener for every token *fetch*, including the one our own
 * registration makes. Reacting to those would loop forever, so only a device token value not
 * seen before triggers a registration, and that registration posts to the API only if the Expo
 * push token actually changed.
 */
export function watchPushTokenChanges() {
  const subscription = Notifications.addPushTokenListener((deviceToken) => {
    const value = deviceToken?.data;
    if (!value || seenDeviceTokens.has(value)) return;
    seenDeviceTokens.add(value);
    registerForPushNotifications();
  });
  return () => subscription.remove();
}

/**
 * Local cleanup on logout/session end: forget the registration, clear shown notifications and
 * invalidate this install's FCM token (the API also clears it on logout).
 */
export async function unregisterPushNotifications() {
  await deleteSecureItem(SECURE_KEYS.PUSH_REGISTRATION);
  usePushStore.setState({ status: 'unknown', error: null });
  await Notifications.dismissAllNotificationsAsync().catch(() => {});
  await Notifications.unregisterForNotificationsAsync().catch(() => {});
}

/** The opaque message id of a "new message" notification, if it is one. */
export function messageIdFromNotification(notification) {
  const data = notification?.request?.content?.data;
  return data?.type === 'new_message' && typeof data.messageId === 'string' ? data.messageId : null;
}

/** The call id of an "Incoming voice call" notification, if it is one. */
export function callIdFromNotification(notification) {
  const data = notification?.request?.content?.data;
  return data?.type === 'incoming_call' && typeof data.callId === 'string' ? data.callId : null;
}

/** Removes the "Incoming voice call" notification of a call that is over. Best effort. */
export async function dismissCallNotifications(callId) {
  try {
    for (const notification of await Notifications.getPresentedNotificationsAsync()) {
      if (callIdFromNotification(notification) === callId) {
        await Notifications.dismissNotificationAsync(notification.request.identifier);
      }
    }
  } catch {
    // Nothing to dismiss, or not supported on this build.
  }
}
