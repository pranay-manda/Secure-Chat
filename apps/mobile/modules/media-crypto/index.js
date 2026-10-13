import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/**
 * JS entry for the local MediaCrypto native module (Android): streams attachment files through
 * libsignal's AES-256-GCM so plaintext media never passes through JavaScript memory. iOS has no
 * implementation yet, so there attachments fail loudly instead of falling back to anything else.
 *
 *   encryptFile(sourceUri, destUri, stripLocation)
 *     -> { key, digest, size, encryptedSize }        key/digest: base64
 *   verifyFile(uri, key, digest, size)               -> true, or throws ERR_MEDIA_INTEGRITY
 *   decryptFile(uri, key, digest, size, destUri)     -> true, or throws (destUri removed)
 *
 * Paths must be inside the app's own files or cache directory (ERR_MEDIA_PATH otherwise).
 */
const native = requireOptionalNativeModule('MediaCrypto');

export function isMediaCryptoAvailable() {
  return native != null;
}

export function getMediaCrypto() {
  if (!native) {
    throw new Error(`Media encryption is not available on ${Platform.OS} in this build`);
  }
  return native;
}
