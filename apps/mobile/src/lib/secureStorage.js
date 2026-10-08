import * as SecureStore from 'expo-secure-store';

/**
 * All secrets on the device go through here (iOS Keychain / Android Keystore via expo-secure-store).
 * Never put secrets in AsyncStorage, MMKV, SQLite plaintext or logs.
 *
 * AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: readable after the first unlock since boot (so background
 * sync can work in later phases), never synced to iCloud and never restored onto another device.
 */
const OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const SECURE_KEYS = Object.freeze({
  SESSION: 'auth.session',
  DEVICE_ID: 'device.id',
  INSTALL_ID: 'device.installId',
  DB_KEY: 'db.key',
  /** Signal long-term identity key pair + registration id (private key never leaves device). */
  SIGNAL_IDENTITY: 'signal.identity',
});

export async function getSecureItem(key) {
  return SecureStore.getItemAsync(key, OPTIONS);
}

export async function setSecureItem(key, value) {
  await SecureStore.setItemAsync(key, value, OPTIONS);
}

export async function deleteSecureItem(key) {
  await SecureStore.deleteItemAsync(key, OPTIONS);
}

export async function getSecureJson(key) {
  const raw = await getSecureItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt entry: treat as absent rather than crash on every launch.
    await deleteSecureItem(key);
    return null;
  }
}

export async function setSecureJson(key, value) {
  await setSecureItem(key, JSON.stringify(value));
}
