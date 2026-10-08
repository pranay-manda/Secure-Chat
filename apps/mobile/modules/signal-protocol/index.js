import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/**
 * JS entry for the local SignalProtocol native module: the official libsignal on both
 * platforms (org.signal:libsignal-android via the Kotlin bridge; LibSignalClient via the Swift
 * bridge in ios/). The Swift bridge has not been compiled or device-tested yet (needs
 * macOS/Xcode), so on a build without it calls fail loudly rather than falling back to any
 * non-audited crypto.
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
