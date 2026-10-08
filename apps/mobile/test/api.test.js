import { loadApp, makeTokens, mockApi, resetDevice, signIn, storedSession } from './helpers';

let app;

beforeEach(() => {
  jest.resetModules();
  resetDevice();
  app = loadApp();
});

const devicesOk = { status: 200, body: { devices: [] } };
const unauthenticated = {
  status: 401,
  body: { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } },
};

describe('apiRequest', () => {
  it('attaches the access token', async () => {
    const { tokens } = await signIn(app);
    const calls = mockApi({ 'GET /devices': () => devicesOk });

    await app.api.apiRequest('GET', '/devices');

    expect(calls[0].headers.Authorization).toBe(`Bearer ${tokens.accessToken}`);
  });

  it('on 401 refreshes once, retries, and persists the rotated tokens', async () => {
    const { tokens } = await signIn(app);
    const rotated = makeTokens();
    const deviceId = await app.deviceId.getDeviceId();
    const calls = mockApi({
      'GET /devices': ({ init }) =>
        init.headers.Authorization === `Bearer ${rotated.accessToken}`
          ? devicesOk
          : unauthenticated,
      'POST /auth/refresh': () => ({ status: 200, body: { tokens: rotated } }),
    });

    const data = await app.api.apiRequest('GET', '/devices');

    expect(data).toEqual({ devices: [] });
    expect(calls.map((c) => c.key)).toEqual(['GET /devices', 'POST /auth/refresh', 'GET /devices']);
    expect(calls[1].body).toEqual({ refreshToken: tokens.refreshToken, deviceId });
    expect(storedSession()).toMatchObject({
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
    });
    expect(app.api.getApiStats().refreshes).toBe(1);
  });

  it('shares one refresh between concurrent requests that all get 401', async () => {
    await signIn(app);
    const rotated = makeTokens();
    const calls = mockApi({
      'GET /devices': ({ init }) =>
        init.headers.Authorization === `Bearer ${rotated.accessToken}`
          ? devicesOk
          : unauthenticated,
      'POST /auth/refresh': async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: 200, body: { tokens: rotated } };
      },
    });

    await Promise.all([1, 2, 3].map(() => app.api.apiRequest('GET', '/devices')));

    expect(calls.filter((c) => c.key === 'POST /auth/refresh')).toHaveLength(1);
  });

  it('refreshes ahead of time when the access token is about to expire', async () => {
    await signIn(app, { tokens: makeTokens({ accessTtlSeconds: 10 }) });
    const rotated = makeTokens();
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: { tokens: rotated } }),
      'GET /devices': () => devicesOk,
    });

    await app.api.apiRequest('GET', '/devices');

    expect(calls.map((c) => c.key)).toEqual(['POST /auth/refresh', 'GET /devices']);
    expect(calls[1].headers.Authorization).toBe(`Bearer ${rotated.accessToken}`);
  });

  it('signs out and wipes local data when the refresh token is rejected', async () => {
    await signIn(app);
    mockApi({
      'GET /devices': () => unauthenticated,
      'POST /auth/refresh': () => ({
        status: 401,
        body: { error: { code: 'REFRESH_TOKEN_REUSED', message: 'reused' } },
      }),
    });

    await expect(app.api.apiRequest('GET', '/devices')).rejects.toBeInstanceOf(
      app.api.SessionExpiredError,
    );

    const { status, notice } = app.auth.useAuthStore.getState();
    expect(status).toBe('signedOut');
    expect(notice).toMatch(/signed out/i);
    expect(storedSession()).toBeNull();
    expect(globalThis.__device.secureStore.has('db.key')).toBe(false);
    expect(globalThis.__device.sqliteFiles.has('securechat.db')).toBe(false);
  });

  it('gets a new deviceId when the server reports the device revoked', async () => {
    await signIn(app);
    const before = await app.deviceId.getDeviceId();
    mockApi({
      'GET /devices': () => unauthenticated,
      'POST /auth/refresh': () => ({
        status: 401,
        body: { error: { code: 'DEVICE_REVOKED', message: 'revoked' } },
      }),
    });

    await expect(app.api.apiRequest('GET', '/devices')).rejects.toThrow();

    expect(await app.deviceId.getDeviceId()).not.toBe(before);
  });

  it('keeps the session when refresh fails because the network is down', async () => {
    const { tokens } = await signIn(app, { tokens: makeTokens({ accessTtlSeconds: 10 }) });
    global.fetch = jest.fn(() => Promise.reject(new TypeError('Network request failed')));

    await expect(app.api.apiRequest('GET', '/devices')).rejects.toBeInstanceOf(
      app.api.NetworkError,
    );

    expect(app.auth.useAuthStore.getState().status).toBe('signedIn');
    expect(storedSession().refreshToken).toBe(tokens.refreshToken);
  });

  it('surfaces API errors with code, details and Retry-After', async () => {
    mockApi({
      'POST /auth/otp/request': () => ({
        status: 429,
        headers: { 'retry-after': '42' },
        body: { error: { code: 'OTP_COOLDOWN', message: 'wait' } },
      }),
    });

    await expect(
      app.api.apiRequest('POST', '/auth/otp/request', { body: {}, auth: false }),
    ).rejects.toMatchObject({ status: 429, code: 'OTP_COOLDOWN', retryAfterSeconds: 42 });
  });
});
