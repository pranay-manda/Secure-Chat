/* global jest */

export const PHONE = '+919876543210';
export const USER = { id: '507f1f77bcf86cd799439011', phoneNumber: PHONE, displayName: '' };

let tokenCounter = 0;

/** Token payload in the exact shape the API returns. */
export function makeTokens({ accessTtlSeconds = 900 } = {}) {
  tokenCounter += 1;
  return {
    accessToken: `header.payload${tokenCounter}.sig`,
    accessTokenExpiresIn: accessTtlSeconds,
    refreshToken: `507f1f77bcf86cd79943901a.refresh${String(tokenCounter).padStart(36, '0')}`,
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  };
}

/** Wipes all simulated device storage (a brand-new phone). */
export function resetDevice() {
  globalThis.__device.secureStore.clear();
  globalThis.__device.sqliteFiles.clear();
  globalThis.__device.sqliteBroken = false;
}

/**
 * Installs a fake `fetch`. `routes` maps "METHOD /path" to a handler returning
 * `{ status, body, headers? }` or throwing (network failure).
 */
export function mockApi(routes) {
  const calls = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    const path = url.replace('http://api.test', '');
    const key = `${init.method ?? 'GET'} ${path}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, headers: init.headers ?? {} });
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected request: ${key}`);
    const { status = 200, body: resBody = null, headers = {} } = await handler({ body, init });
    return {
      status,
      json: async () => resBody,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    };
  });
  return calls;
}

/** Loads the app's modules fresh, like a cold start. */
export function loadApp() {
  return {
    auth: require('../src/auth/authStore'),
    api: require('../src/lib/api'),
    tokenStore: require('../src/auth/tokenStore'),
    deviceId: require('../src/lib/deviceId'),
    db: require('../src/db/database'),
  };
}

export function secureStoreKeys() {
  return [...globalThis.__device.secureStore.keys()].sort();
}

export function storedSession() {
  const raw = globalThis.__device.secureStore.get('auth.session');
  return raw ? JSON.parse(raw) : null;
}

/** Performs an OTP login through the real auth store against the fake API. */
export async function signIn(app, { tokens = makeTokens() } = {}) {
  const calls = mockApi({
    'POST /auth/otp/verify': () => ({
      body: { user: { ...USER, isNew: false }, device: {}, tokens },
    }),
  });
  await app.auth.useAuthStore.getState().verifyOtp(PHONE, '123456');
  return { calls, tokens };
}
