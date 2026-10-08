import { ERROR_CODE } from '@secure-chat/shared/constants';

import { getCachedSession, loadSession, saveSession, sessionFromTokens } from '../auth/tokenStore';
import { env } from '../config/env';
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
    throw new NetworkError(err?.name === 'AbortError' ? 'Request timed out' : undefined);
  } finally {
    clearTimeout(timer);
  }

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

async function performRefresh() {
  const session = await loadSession();
  if (!session?.refreshToken) {
    await onSessionEnded(ERROR_CODE.REFRESH_TOKEN_INVALID);
    throw new SessionExpiredError(ERROR_CODE.REFRESH_TOKEN_INVALID);
  }

  const result = await send('POST', '/auth/refresh', {
    body: { refreshToken: session.refreshToken, deviceId: await getDeviceId() },
  });

  if (result.status === 200) {
    // Persist before use: the old refresh token is now spent on the server.
    await saveSession(sessionFromTokens(result.data.tokens, session.user));
    stats.refreshes += 1;
    return getCachedSession().accessToken;
  }

  const error = toApiError(result);
  if (result.status === 401 || result.status === 403 || SESSION_ENDING_CODES.has(error.code)) {
    await onSessionEnded(error.code);
    throw new SessionExpiredError(error.code);
  }
  // 429 / 5xx: temporary; keep the session and let the caller retry later.
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
