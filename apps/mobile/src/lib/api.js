import { ERROR_CODE } from '@secure-chat/shared/constants';
import { getRandomBytesAsync } from 'expo-crypto';

import { getCachedSession, loadSession, saveSession, sessionFromTokens } from '../auth/tokenStore';
import { ENDPOINTS } from '../config/endpoints';
import { bytesToBase64 } from '../crypto/encoding';
import { env } from '../config/env';
import { markReachable, markUnreachable } from './connectivity';
import { getDeviceId } from './deviceId';

const DEFAULT_TIMEOUT_MS = 15_000;
/** Refresh proactively when the access token has less than this left. */
const REFRESH_LEEWAY_MS = 30_000;

/** Server rejected the request; `code` is a stable ERROR_CODE. */
export class ApiError extends Error {
  constructor(status, code, message, { details, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request never got a response (offline, DNS, timeout). Session is kept. */
export class NetworkError extends Error {
  constructor(message = 'Network unavailable') {
    super(message);
    this.name = 'NetworkError';
  }
}

/** The session can no longer be renewed; the user must sign in again. */
export class SessionExpiredError extends Error {
  constructor(code) {
    super('Session expired');
    this.name = 'SessionExpiredError';
    this.code = code;
  }
}

// Set by the auth store, called when the server definitively ends the session.
let onSessionEnded = async () => {};
export function setSessionEndedHandler(handler) {
  onSessionEnded = handler;
}

const stats = { refreshes: 0 };
export function getApiStats() {
  return { ...stats };
}

async function send(method, path, { body, accessToken, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${env.apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    markUnreachable(); // the backend could not be reached at all (see lib/connectivity.js)
    throw new NetworkError(err?.name === 'AbortError' ? 'Request timed out' : undefined);
  } finally {
    clearTimeout(timer);
  }
  markReachable(); // any answer, even an error, proves the backend is reachable

  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, data, headers: response.headers };
}

function toApiError({ status, data, headers }) {
  const error = data?.error ?? {};
  const retryAfter = Number(headers?.get?.('retry-after'));
  return new ApiError(status, error.code ?? 'HTTP_ERROR', error.message ?? `HTTP ${status}`, {
    details: error.details,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  });
}

const SESSION_ENDING_CODES = new Set([
  ERROR_CODE.REFRESH_TOKEN_INVALID,
  ERROR_CODE.REFRESH_TOKEN_REUSED,
  ERROR_CODE.DEVICE_REVOKED,
]);

/** 32 random bytes as base64url without padding: the server's refresh-secret format. */
async function newRefreshSecret() {
  const base64 = bytesToBase64(await getRandomBytesAsync(32));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The rotation this refresh performs: the current refresh token and the secret proposed for
 * the next one, saved with the session BEFORE the request is sent. If the answer is lost
 * (timeout, dropped connection, app reloaded or killed), the server may already have rotated;
 * sending exactly the same request again lets it recognise the retry instead of seeing a spent
 * token, which it must treat as theft. A new proposal is made only for a new refresh token.
 */
async function pendingRotation(session) {
  if (session.pendingRefresh?.from === session.refreshToken) return session.pendingRefresh;
  const pendingRefresh = { from: session.refreshToken, nextSecret: await newRefreshSecret() };
  assertSessionUnchanged(session.refreshToken);
  await saveSession({ ...session, pendingRefresh });
  return pendingRefresh;
}

/**
 * Signed out (or signed in again) while a refresh ran: its outcome belongs to a session that
 * no longer exists here, and saving it would bring signed-out credentials back.
 */
function assertSessionUnchanged(refreshToken) {
  if (getCachedSession()?.refreshToken !== refreshToken) {
    throw new SessionExpiredError(ERROR_CODE.UNAUTHENTICATED);
  }
}

async function performRefresh() {
  const session = await loadSession();
  if (!session?.refreshToken) {
    await onSessionEnded(ERROR_CODE.REFRESH_TOKEN_INVALID);
    throw new SessionExpiredError(ERROR_CODE.REFRESH_TOKEN_INVALID);
  }

  const pending = await pendingRotation(session);
  const result = await send('POST', ENDPOINTS.AUTH.REFRESH, {
    body: {
      refreshToken: pending.from,
      deviceId: await getDeviceId(),
      nextRefreshSecret: pending.nextSecret,
    },
  });
  assertSessionUnchanged(pending.from);

  if (result.status === 200) {
    // Persist before use: the old refresh token is now spent on the server. The new session
    // has no pending rotation.
    await saveSession(sessionFromTokens(result.data.tokens, session.user));
    stats.refreshes += 1;
    return getCachedSession().accessToken;
  }

  const error = toApiError(result);
  if (result.status === 401 || result.status === 403 || SESSION_ENDING_CODES.has(error.code)) {
    await onSessionEnded(error.code);
    throw new SessionExpiredError(error.code);
  }
  // 400: the server rejected the request before rotating anything, so the next attempt can
  // safely propose a new secret.
  if (result.status === 400) await saveSession({ ...getCachedSession(), pendingRefresh: null });
  // 429 / 5xx / no answer (NetworkError, above): temporary. The session and the pending
  // rotation are kept; the server may have rotated, and only the same request recovers that.
  throw error;
}

let refreshInFlight = null;

/**
 * Single-flight refresh: concurrent callers share one network call. Two parallel refreshes
 * with the same token would look like token theft to the server and end the session.
 */
export function refreshSession() {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function getAccessToken() {
  const session = await loadSession();
  if (!session) throw new SessionExpiredError(ERROR_CODE.UNAUTHENTICATED);
  if (session.accessTokenExpiresAt - Date.now() < REFRESH_LEEWAY_MS) {
    return refreshSession();
  }
  return session.accessToken;
}

/**
 * JSON API call. With `auth` (default) it attaches the access token, refreshes it ahead of
 * expiry, and on a 401 refreshes once and retries once.
 *
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path
 * @param {{ body?: unknown, auth?: boolean, timeoutMs?: number }} [options]
 */
export async function apiRequest(method, path, { body, auth = true, timeoutMs } = {}) {
  if (!auth) {
    const result = await send(method, path, { body, timeoutMs });
    if (result.status >= 400) throw toApiError(result);
    return result.data;
  }

  const token = await getAccessToken();
  let result = await send(method, path, { body, accessToken: token, timeoutMs });

  if (result.status === 401) {
    // Another request may already have refreshed while this one was in flight.
    const current = getCachedSession()?.accessToken;
    const retryToken = current && current !== token ? current : await refreshSession();
    result = await send(method, path, { body, accessToken: retryToken, timeoutMs });
    if (result.status === 401) {
      await onSessionEnded(ERROR_CODE.UNAUTHENTICATED);
      throw new SessionExpiredError(ERROR_CODE.UNAUTHENTICATED);
    }
  }

  if (result.status >= 400) throw toApiError(result);
  return result.data;
}
