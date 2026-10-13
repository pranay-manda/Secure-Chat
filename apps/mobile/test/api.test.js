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
/** The server's refresh-secret format: 32 bytes, base64url, no padding. */
const REFRESH_SECRET = /^[A-Za-z0-9_-]{43}$/;
const reused = {
  status: 401,
  body: { error: { code: 'REFRESH_TOKEN_REUSED', message: 'reused' } },
};

/**
 * A fake POST /auth/refresh with the server's rotation rules (authService.refresh): each token
 * works once; the next token is `<session>.<proposed secret>`; repeating the request that made
 * the current token (same token, same proposal) is answered again; anything else is reuse.
 * `loseAnswers` makes that many requests rotate on the "server" and then fail on the way
 * back, as when the app is killed or the connection drops.
 */
function refreshServer(initialRefreshToken, { loseAnswers = 0 } = {}) {
  const state = { current: initialRefreshToken, previous: null, rotations: 0, revoked: false };
  let toLose = loseAnswers;
  const handler = ({ body }) => {
    const [sessionId] = body.refreshToken.split('.');
    const proposed = body.nextRefreshSecret && `${sessionId}.${body.nextRefreshSecret}`;
    if (state.revoked) return reused;
    if (body.refreshToken === state.current) {
      state.previous = state.current;
      // Without a proposal the server picks the secret, and a repeat cannot be recognised.
      state.current = proposed ?? `${sessionId}.server${state.rotations}`;
      state.rotations += 1;
    } else if (!proposed || body.refreshToken !== state.previous || proposed !== state.current) {
      state.revoked = true;
      return reused;
    }
    if (toLose > 0) {
      toLose -= 1;
      throw new TypeError('Network request failed');
    }
    return { status: 200, body: { tokens: { ...makeTokens(), refreshToken: state.current } } };
  };
  return { state, handler };
}

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
    expect(calls[1].body).toEqual({
      refreshToken: tokens.refreshToken,
      deviceId,
      nextRefreshSecret: expect.stringMatching(REFRESH_SECRET),
    });
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

  it('keeps the signed-out state when a refresh answers after logout', async () => {
    await signIn(app);
    let answer;
    mockApi({
      'POST /auth/refresh': () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      'POST /auth/logout': () => ({ status: 204 }),
    });

    const refreshing = app.api.refreshSession();
    await new Promise((resolve) => setTimeout(resolve, 10)); // the refresh is on the wire
    await app.auth.useAuthStore.getState().logout();
    answer({ status: 200, body: { tokens: makeTokens() } });

    await expect(refreshing).rejects.toBeInstanceOf(app.api.SessionExpiredError);
    expect(app.auth.useAuthStore.getState().status).toBe('signedOut');
    expect(storedSession()).toBeNull();
    expect(app.tokenStore.getCachedSession()).toBeNull();
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

describe('refresh-token rotation that survives lost answers', () => {
  const nearExpiry = () => makeTokens({ accessTtlSeconds: 10 }); // refreshed before any request

  it('saves the proposed next secret before sending, and drops it once rotated', async () => {
    const { tokens } = await signIn(app);
    let storedDuringRequest;
    const rotated = makeTokens();
    const calls = mockApi({
      'POST /auth/refresh': () => {
        storedDuringRequest = storedSession();
        return { status: 200, body: { tokens: rotated } };
      },
    });

    await app.api.refreshSession();

    const { nextRefreshSecret } = calls[0].body;
    expect(nextRefreshSecret).toMatch(REFRESH_SECRET);
    expect(storedDuringRequest.pendingRefresh).toEqual({
      from: tokens.refreshToken,
      nextSecret: nextRefreshSecret,
    });
    expect(storedSession().refreshToken).toBe(rotated.refreshToken);
    expect(storedSession().pendingRefresh).toBeUndefined();
  });

  it('recovers from a lost answer after an app reload without signing out', async () => {
    // The reproduced race: the server rotated, the app never got the answer and was killed.
    const { tokens } = await signIn(app, { tokens: nearExpiry() });
    const server = refreshServer(tokens.refreshToken, { loseAnswers: 1 });
    const calls = mockApi({
      'POST /auth/refresh': server.handler,
      'GET /devices': () => devicesOk,
    });

    await expect(app.api.apiRequest('GET', '/devices')).rejects.toBeInstanceOf(
      app.api.NetworkError,
    );
    expect(server.state.rotations).toBe(1); // the server did rotate
    expect(storedSession().refreshToken).toBe(tokens.refreshToken); // the app has the old one

    jest.resetModules(); // force-close and relaunch
    app = loadApp();
    await app.auth.useAuthStore.getState().initialize();
    await expect(app.api.apiRequest('GET', '/devices')).resolves.toEqual({ devices: [] });

    const refreshes = calls.filter((c) => c.key === 'POST /auth/refresh').map((c) => c.body);
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]).toEqual(refreshes[0]); // exactly the same request
    expect(server.state).toMatchObject({ rotations: 1, revoked: false });
    expect(app.auth.useAuthStore.getState().status).toBe('signedIn');
    expect(storedSession().refreshToken).toBe(server.state.current);
    expect(storedSession().pendingRefresh).toBeUndefined();
    // Nothing local was wiped: the encrypted database and its key are still there.
    expect(globalThis.__device.sqliteFiles.has('securechat.db')).toBe(true);
    expect(globalThis.__device.secureStore.has('db.key')).toBe(true);
  });

  it('retries a timed-out refresh with the same proposal, then proposes anew', async () => {
    const { tokens } = await signIn(app, { tokens: nearExpiry() });
    const server = refreshServer(tokens.refreshToken, { loseAnswers: 2 });
    const calls = mockApi({ 'POST /auth/refresh': server.handler });

    await expect(app.api.refreshSession()).rejects.toBeInstanceOf(app.api.NetworkError);
    await expect(app.api.refreshSession()).rejects.toBeInstanceOf(app.api.NetworkError);
    await app.api.refreshSession();
    await app.api.refreshSession(); // a normal rotation of the recovered token

    const bodies = calls.map((c) => c.body);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[3].refreshToken).toBe(server.state.previous);
    expect(bodies[3].nextRefreshSecret).not.toBe(bodies[0].nextRefreshSecret);
    expect(server.state).toMatchObject({ rotations: 2, revoked: false });
    expect(storedSession().refreshToken).toBe(server.state.current);
  });

  it('shares one rotation between concurrent callers and never sends two proposals', async () => {
    const { tokens } = await signIn(app, { tokens: nearExpiry() });
    const server = refreshServer(tokens.refreshToken);
    const calls = mockApi({
      'POST /auth/refresh': async (req) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return server.handler(req);
      },
      'GET /devices': () => devicesOk,
    });

    await Promise.all([1, 2, 3].map(() => app.api.apiRequest('GET', '/devices')));

    expect(calls.filter((c) => c.key === 'POST /auth/refresh')).toHaveLength(1);
    expect(server.state).toMatchObject({ rotations: 1, revoked: false });
  });

  it('keeps the pending rotation through server errors', async () => {
    const { tokens } = await signIn(app);
    const calls = mockApi({
      'POST /auth/refresh': () => ({
        status: 503,
        body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'down' } },
      }),
    });

    await expect(app.api.refreshSession()).rejects.toMatchObject({ status: 503 });
    await expect(app.api.refreshSession()).rejects.toMatchObject({ status: 503 });

    expect(calls[1].body).toEqual(calls[0].body);
    expect(storedSession().pendingRefresh.from).toBe(tokens.refreshToken);
    expect(app.auth.useAuthStore.getState().status).toBe('signedIn');
  });

  it('drops a proposal the server rejected as invalid (400), which rotated nothing', async () => {
    await signIn(app);
    const calls = mockApi({
      'POST /auth/refresh': () => ({
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } },
      }),
    });

    await expect(app.api.refreshSession()).rejects.toMatchObject({ status: 400 });
    await expect(app.api.refreshSession()).rejects.toMatchObject({ status: 400 });

    expect(calls[1].body.nextRefreshSecret).not.toBe(calls[0].body.nextRefreshSecret);
    expect(storedSession().pendingRefresh).toBeNull();
    expect(app.auth.useAuthStore.getState().status).toBe('signedIn');
  });

  it('still signs out and wipes when the server reports genuine reuse', async () => {
    const { tokens } = await signIn(app);
    // Someone else already rotated this token with their own proposal.
    const server = refreshServer(tokens.refreshToken);
    server.handler({
      body: { refreshToken: tokens.refreshToken, nextRefreshSecret: 'x'.repeat(43) },
    });
    mockApi({ 'POST /auth/refresh': server.handler });

    await expect(app.api.refreshSession()).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
    });

    expect(server.state.revoked).toBe(true);
    expect(app.auth.useAuthStore.getState().status).toBe('signedOut');
    expect(storedSession()).toBeNull();
    expect(globalThis.__device.sqliteFiles.has('securechat.db')).toBe(false);
  });

  it('logout removes a pending rotation with the rest of the session', async () => {
    await signIn(app);
    mockApi({
      'POST /auth/refresh': () => {
        throw new TypeError('Network request failed');
      },
      'POST /auth/logout': () => ({ status: 204 }),
    });
    await expect(app.api.refreshSession()).rejects.toBeInstanceOf(app.api.NetworkError);
    expect(storedSession().pendingRefresh).toBeDefined();

    await app.auth.useAuthStore.getState().logout();

    expect(storedSession()).toBeNull();
    expect(globalThis.__device.secureStore.has('auth.session')).toBe(false);
  });
});
