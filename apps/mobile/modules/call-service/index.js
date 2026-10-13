import { requireOptionalNativeModule } from 'expo';

/**
 * JS entry for the local CallService native module (Android only).
 *
 * Since Android 11 the system silences the microphone of an app that is in the background
 * unless it runs a foreground service of type "microphone". While a call holds the microphone,
 * this service keeps it working when the user switches apps or locks the screen, and shows an
 * ongoing "Voice call in progress" notification as Android requires.
 *
 * iOS keeps call audio running through the "audio" background mode instead, so the module does
 * not exist there (nor in tests): both functions are then harmless no-ops.
 */
const native = requireOptionalNativeModule('CallService');

/** Starts the service. Only works while the app is in the foreground. Returns true if started. */
export function startCallService() {
  try {
    return native?.start() === true;
  } catch {
    return false;
  }
}

export function stopCallService() {
  try {
    native?.stop();
  } catch {
    // Not running.
  }
}
