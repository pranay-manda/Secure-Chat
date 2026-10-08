import { deleteSecureItem, getSecureJson, SECURE_KEYS, setSecureJson } from '../lib/secureStorage';

/**
 * The whole session is ONE secure-storage entry, so a rotation (new access + refresh token)
 * is written atomically: a crash can never leave a new access token next to an old refresh token.
 *
 * Shape: { accessToken, accessTokenExpiresAt (ms epoch), refreshToken,
 *          refreshTokenExpiresAt (ms epoch), user }
 * A copy is kept in memory so requests do not hit the keychain every time.
 */
let session;
let loaded = false;

/** Converts the API's `tokens` object into the stored shape. */
export function sessionFromTokens(tokens, user, now = Date.now()) {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: now + tokens.accessTokenExpiresIn * 1000,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: Date.parse(tokens.refreshTokenExpiresAt),
    user,
  };
}

export async function loadSession() {
  if (!loaded) {
    session = await getSecureJson(SECURE_KEYS.SESSION);
    loaded = true;
  }
  return session;
}

export function getCachedSession() {
  return session ?? null;
}

export async function saveSession(next) {
  await setSecureJson(SECURE_KEYS.SESSION, next);
  session = next;
  loaded = true;
}

export async function clearSession() {
  session = null;
  loaded = true;
  await deleteSecureItem(SECURE_KEYS.SESSION);
}

/**
 * Development helper for manual testing: replaces the stored access token with one the
 * server will reject, without touching its expiry, to exercise the 401 -> refresh path.
 */
export async function devInvalidateAccessToken() {
  if (!__DEV__ || !session) return;
  const [header, payload] = session.accessToken.split('.');
  await saveSession({ ...session, accessToken: `${header}.${payload}.invalidsignature` });
}
