import * as LocalAuthentication from 'expo-local-authentication';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { isConversationLocked, setConversationLocked } from '../messaging/messageStore';

/**
 * Chat Lock: LOCAL access control for individual conversations.
 *
 * It is not encryption. Messages are already end-to-end encrypted (Signal Protocol) in transit
 * and stored in the SQLCipher-encrypted database; Chat Lock only decides whether this app will
 * show a conversation without the device owner re-authenticating.
 *
 * Authentication is done entirely by the OS (BiometricPrompt / Face ID, with the device PIN,
 * pattern or password as fallback). The app only learns success or failure; it never sees or
 * stores biometric data. Lock state lives only in the local encrypted database and is never
 * sent to the server, Pusher or push notifications.
 */

/**
 * One successful authentication unlocks locked chats until the app leaves the foreground.
 * `unlocked` is memory-only: a restart or force-close always starts locked.
 */
export const useChatLockStore = create(() => ({ unlocked: false }));

export function isChatLockSessionUnlocked() {
  return useChatLockStore.getState().unlocked;
}

/** Re-lock everything (backgrounding, logout). */
export function relockChats() {
  useChatLockStore.setState({ unlocked: false });
}

// Leaving the foreground ends the unlock session, so returning to an open locked chat (or the
// Locked chats list) requires authentication again. 'inactive' (iOS app switcher) counts too.
AppState.addEventListener('change', (state) => {
  if (state !== 'active') relockChats();
});

/** Error codes returned to the UI (no OS details that could differ per device are needed). */
export const LOCK_ERROR = Object.freeze({
  NO_DEVICE_LOCK: 'NO_DEVICE_LOCK', // no fingerprint/face AND no screen lock set up
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  LOCKOUT: 'LOCKOUT',
  UNAVAILABLE: 'UNAVAILABLE',
});

/** What this device can use for Chat Lock (for Settings). */
export async function getChatLockCapability() {
  try {
    const [level, types] = await Promise.all([
      LocalAuthentication.getEnrolledLevelAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    const { SecurityLevel, AuthenticationType } = LocalAuthentication;
    return {
      available: level !== SecurityLevel.NONE,
      biometric: level === SecurityLevel.BIOMETRIC_STRONG || level === SecurityLevel.BIOMETRIC_WEAK,
      fingerprint: types.includes(AuthenticationType.FINGERPRINT),
      face: types.includes(AuthenticationType.FACIAL_RECOGNITION),
    };
  } catch {
    return { available: false, biometric: false, fingerprint: false, face: false };
  }
}

function mapError(error) {
  switch (error) {
    case 'user_cancel':
    case 'system_cancel':
    case 'app_cancel':
    case 'user_fallback':
      return LOCK_ERROR.CANCELLED;
    case 'lockout':
    case 'lockout_permanent':
      return LOCK_ERROR.LOCKOUT;
    case 'not_enrolled':
    case 'passcode_not_set':
      return LOCK_ERROR.NO_DEVICE_LOCK;
    case 'authentication_failed':
      return LOCK_ERROR.FAILED;
    default:
      return LOCK_ERROR.UNAVAILABLE;
  }
}

/**
 * Asks the OS to authenticate the device owner: biometrics first, device PIN/pattern/password
 * as fallback. Requires that the device has some screen lock; without one there is nothing
 * trustworthy to verify against, so Chat Lock refuses rather than inventing an app PIN.
 *
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function authenticateOwner(promptMessage) {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) {
      return { ok: false, error: LOCK_ERROR.NO_DEVICE_LOCK };
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false, // allow PIN/pattern/password when biometrics are unavailable
    });
    return result.success ? { ok: true } : { ok: false, error: mapError(result.error) };
  } catch {
    return { ok: false, error: LOCK_ERROR.UNAVAILABLE };
  }
}

/**
 * Authenticates and, on success, starts the unlock session. Concurrent callers (e.g. two
 * screens re-locking at once) share one OS prompt.
 */
let unlockInFlight = null;
export function unlockChats(promptMessage = 'Unlock your locked chats') {
  unlockInFlight ??= authenticateOwner(promptMessage)
    .then((result) => {
      if (result.ok) useChatLockStore.setState({ unlocked: true });
      return result;
    })
    .finally(() => {
      unlockInFlight = null;
    });
  return unlockInFlight;
}

/** Locks a conversation after successful authentication; on failure nothing changes. */
export async function lockConversation(peerUserId) {
  const result = await authenticateOwner('Lock this chat');
  if (!result.ok) return result;
  await setConversationLocked(peerUserId, true);
  // The owner just authenticated, so the chat they are looking at stays available.
  useChatLockStore.setState({ unlocked: true });
  return result;
}

/** Unlocks (removes the lock from) a conversation after successful authentication. */
export async function unlockConversation(peerUserId) {
  const result = await authenticateOwner('Remove the lock from this chat');
  if (!result.ok) return result;
  await setConversationLocked(peerUserId, false);
  return result;
}

/**
 * Whether a conversation may be shown right now. Called BEFORE any message of the
 * conversation is read from the database.
 */
export async function canShowConversation(peerUserId) {
  if (!(await isConversationLocked(peerUserId))) return true;
  return isChatLockSessionUnlocked();
}

/** User-facing text for a failed attempt. */
export function chatLockErrorMessage(error) {
  switch (error) {
    case LOCK_ERROR.NO_DEVICE_LOCK:
      return 'Set up a screen lock (PIN, pattern, password or fingerprint) on this device to use Chat Lock.';
    case LOCK_ERROR.LOCKOUT:
      return 'Too many attempts. Unlock your device, then try again.';
    case LOCK_ERROR.CANCELLED:
      return null; // the user chose to cancel: no error to show
    case LOCK_ERROR.FAILED:
      return 'Authentication failed. Try again.';
    default:
      return 'Authentication is not available right now. Try again.';
  }
}
