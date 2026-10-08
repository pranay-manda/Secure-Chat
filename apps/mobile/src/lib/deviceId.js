import { randomUUID } from 'expo-crypto';

import { getSecureItem, SECURE_KEYS, setSecureItem } from './secureStorage';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let cached = null;

/**
 * Stable per-install identifier (UUID v4 from the OS CSPRNG), created on first use and kept in
 * secure storage. Survives logout and app restarts. It is replaced only when the server reports
 * the device as revoked, or when a reinstall is detected (see auth/session.js).
 */
export async function getDeviceId() {
  if (cached) return cached;

  const stored = await getSecureItem(SECURE_KEYS.DEVICE_ID);
  if (stored && UUID_V4.test(stored)) {
    cached = stored;
    return cached;
  }
  return resetDeviceId();
}

/** Generates and persists a brand-new deviceId (a revoked deviceId can never sign in again). */
export async function resetDeviceId() {
  const next = randomUUID();
  await setSecureItem(SECURE_KEYS.DEVICE_ID, next);
  cached = next;
  return next;
}
