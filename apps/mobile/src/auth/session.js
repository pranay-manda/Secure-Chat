import { randomUUID } from 'expo-crypto';

import { destroyDatabase, getMeta, openDatabase, setMeta } from '../db/database';
import { resetDeviceId } from '../lib/deviceId';
import { stopMessaging } from '../messaging/messagingEngine';
import { deleteSecureItem, getSecureItem, SECURE_KEYS, setSecureItem } from '../lib/secureStorage';
import { clearSession, loadSession, saveSession, sessionFromTokens } from './tokenStore';

const INSTALL_ID_META = 'install_id';

/**
 * Starts a local session after a successful OTP login: persists tokens, opens the encrypted
 * database and stamps it with an install id (used to detect reinstalls, see restoreSession).
 */
export async function startSession({ tokens, user }) {
  try {
    // Database first: if encrypted storage is unavailable, no credentials are left behind.
    await openDatabase();
    const installId = randomUUID();
    await setMeta(INSTALL_ID_META, installId);
    await setSecureItem(SECURE_KEYS.INSTALL_ID, installId);
    await saveSession(sessionFromTokens(tokens, user));
  } catch (err) {
    await wipeLocalSession().catch(() => {});
    throw err;
  }
}

/**
 * Restores the session after a restart or force-close. Returns the user, or null if signed out.
 *
 * iOS keeps Keychain items after uninstall, but the database file is deleted. A session in the
 * Keychain without a matching database means "reinstalled": the old credentials are discarded.
 */
export async function restoreSession() {
  const session = await loadSession();
  if (!session?.refreshToken) return null;

  if (session.refreshTokenExpiresAt <= Date.now()) {
    await wipeLocalSession();
    return null;
  }

  await openDatabase();
  const [storedInstallId, dbInstallId] = await Promise.all([
    getSecureItem(SECURE_KEYS.INSTALL_ID),
    getMeta(INSTALL_ID_META),
  ]);
  if (!storedInstallId || storedInstallId !== dbInstallId) {
    await wipeLocalSession({ newDeviceId: true });
    return null;
  }

  return session.user;
}

/**
 * Removes every local trace of the session: tokens, the encrypted database file and its key
 * (which also holds Signal sessions and pre-keys), and the Signal identity key pair.
 * The deviceId is kept (the server still knows this device) unless `newDeviceId` is set,
 * which is required after the server revoked it.
 */
export async function wipeLocalSession({ newDeviceId = false } = {}) {
  // Stop realtime and sync first so nothing writes into the database while it is destroyed.
  stopMessaging();
  await clearSession();
  await destroyDatabase();
  await deleteSecureItem(SECURE_KEYS.INSTALL_ID);
  await deleteSecureItem(SECURE_KEYS.SIGNAL_IDENTITY);
  if (newDeviceId) await resetDeviceId();
}
