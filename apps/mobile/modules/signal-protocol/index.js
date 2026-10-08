import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/**
 * JS entry for the local SignalProtocol native module (official libsignal on Android).
 * iOS bridging (LibSignalClient Swift package) is not built yet; calls fail loudly rather than
 * falling back to any non-audited crypto.
 */
const native = requireOptionalNativeModule('SignalProtocol');

export function isSignalAvailable() {
  return native != null;
}

export function getSignalNative() {
  if (!native) {
    throw new Error(
      `Signal Protocol native module is not available on ${Platform.OS} in this build`,
    );
  }
  return native;
}
