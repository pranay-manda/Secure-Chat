import {
  loadApp,
  makeTokens,
  mockApi,
  PHONE,
  resetDevice,
  secureStoreKeys,
  signIn,
  storedSession,
} from './helpers';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let app;

beforeEach(() => {
  jest.resetModules();
  resetDevice();
  app = loadApp();
});

const state = () => app.auth.useAuthStore.getState();

describe('OTP sign-in', () => {
  it('sends a persistent UUID v4 deviceId and device details', async () => {
    const { calls } = await signIn(app);

    const { device } = calls[0].body;
    expect(device.deviceId).toMatch(UUID_V4);
    expect(device.platform).toMatch(/^(ios|android)$/);
    expect(calls[0].body.phoneNumber).toBe(PHONE);
    expect(globalThis.__device.secureStore.get('device.id')).toBe(device.deviceId);
  });

  it('stores tokens only in secure storage, as one entry', async () => {
    const { tokens } = await signIn(app);

    expect(state().status).toBe('signedIn');
    expect(storedSession()).toMatchObject({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: { phoneNumber: PHONE },
    });
    expect(secureStoreKeys()).toEqual(['auth.session', 'db.key', 'device.id', 'device.installId']);

    // Nothing token-like ends up in the local database.
    const dbBytes = Buffer.from(globalThis.__device.sqliteFiles.get('securechat.db').db.export());
    expect(dbBytes.includes(Buffer.from(tokens.refreshToken))).toBe(false);
    expect(dbBytes.includes(Buffer.from(tokens.accessToken))).toBe(false);
  });

  it('opens the local database with a random 256-bit raw SQLCipher key from secure storage', async () => {
    await signIn(app);

    const key = globalThis.__device.secureStore.get('db.key');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(globalThis.__device.sqliteFiles.get('securechat.db').key).toBe(key);
    expect(app.db.getCipherVersion()).toMatch(/^4\./);
  });

  it('leaves no credentials behind if the encrypted database cannot be opened', async () => {
    globalThis.__device.sqliteBroken = true;

    await expect(signIn(app)).rejects.toThrow(/dlopen/);

    expect(state().status).not.toBe('signedIn');
    expect(storedSession()).toBeNull();
    expect(secureStoreKeys()).toEqual(['device.id']);
  });

  it('switches to a new deviceId when the server says this one was revoked', async () => {
    const before = await app.deviceId.getDeviceId();
    mockApi({
      'POST /auth/otp/verify': () => ({
        status: 403,
        body: { error: { code: 'DEVICE_REVOKED', message: 'revoked' } },
      }),
    });

    await expect(state().verifyOtp(PHONE, '123456')).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });
    expect(await app.deviceId.getDeviceId()).not.toBe(before);
    expect(state().status).not.toBe('signedIn');
  });
});

describe('email OTP sign-in', () => {
  const EMAIL = 'alice@example.com';
  const EMAIL_USER = { id: '507f1f77bcf86cd799439012', email: EMAIL, displayName: '' };

  it('requests a code with only the email address', async () => {
    const calls = mockApi({
      'POST /auth/otp/request': () => ({
        status: 202,
        body: { expiresInSeconds: 300, resendAfterSeconds: 60 },
      }),
    });

    const result = await state().requestOtp({ email: EMAIL });

    expect(result.resendAfterSeconds).toBe(60);
    expect(calls[0].body).toEqual({ email: EMAIL });
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('signs in through the same session flow, tokens kept in secure storage', async () => {
    const tokens = makeTokens();
    const calls = mockApi({
      'POST /auth/otp/verify': () => ({
        body: { user: { ...EMAIL_USER, isNew: true }, device: {}, tokens },
      }),
    });

    await state().verifyOtp({ email: EMAIL }, '123456');

    expect(calls[0].body).toMatchObject({ email: EMAIL, otp: '123456' });
    expect(calls[0].body.phoneNumber).toBeUndefined();
    expect(calls[0].body.device.deviceId).toMatch(UUID_V4);
    expect(state()).toMatchObject({ status: 'signedIn', user: { email: EMAIL } });
    expect(storedSession()).toMatchObject({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: { email: EMAIL },
    });
    expect(secureStoreKeys()).toEqual(['auth.session', 'db.key', 'device.id', 'device.installId']);
    expect(app.db.getCipherVersion()).toMatch(/^4\./);
  });

  it('explains when phone sign-in is not available yet', () => {
    const { authErrorMessage } = require('../src/auth/errorMessages');
    expect(authErrorMessage({ code: 'OTP_CHANNEL_UNAVAILABLE' })).toMatch(/use your email/);
  });
});

describe('restore after force-close / restart', () => {
  it('stays signed in after the app is killed and reopened, without network', async () => {
    const { tokens } = await signIn(app);
    const deviceIdBefore = await app.deviceId.getDeviceId();

    jest.resetModules(); // force-close: all JS state is gone
    app = loadApp();
    global.fetch = jest.fn(() => Promise.reject(new Error('offline')));
    await state().initialize();

    expect(state().status).toBe('signedIn');
    expect(state().user.phoneNumber).toBe(PHONE);
    expect(app.tokenStore.getCachedSession().refreshToken).toBe(tokens.refreshToken);
    expect(await app.deviceId.getDeviceId()).toBe(deviceIdBefore);
    expect(app.db.getCipherVersion()).toBeTruthy(); // encrypted DB reopened with stored key
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('starts signed out on a fresh install', async () => {
    await state().initialize();
    expect(state().status).toBe('signedOut');
  });

  it('signs out at startup if the refresh session has expired', async () => {
    await signIn(app);
    const session = storedSession();
    globalThis.__device.secureStore.set(
      'auth.session',
      JSON.stringify({ ...session, refreshTokenExpiresAt: Date.now() - 1000 }),
    );

    jest.resetModules();
    app = loadApp();
    await state().initialize();

    expect(state().status).toBe('signedOut');
    expect(storedSession()).toBeNull();
  });

  it('discards Keychain leftovers after a reinstall (database gone, credentials still present)', async () => {
    await signIn(app);
    const oldDeviceId = await app.deviceId.getDeviceId();
    globalThis.__device.sqliteFiles.clear(); // uninstall deletes files, iOS Keychain survives

    jest.resetModules();
    app = loadApp();
    await state().initialize();

    expect(state().status).toBe('signedOut');
    expect(storedSession()).toBeNull();
    expect(await app.deviceId.getDeviceId()).not.toBe(oldDeviceId);
  });
});

describe('logout', () => {
  it('revokes the session on the server and wipes local credentials and data', async () => {
    const { tokens } = await signIn(app);
    const deviceId = await app.deviceId.getDeviceId();
    const calls = mockApi({ 'POST /auth/logout': () => ({ status: 204 }) });

    await state().logout();

    expect(calls[0].headers.Authorization).toBe(`Bearer ${tokens.accessToken}`);
    expect(state()).toMatchObject({ status: 'signedOut', user: null });
    expect(secureStoreKeys()).toEqual(['device.id']); // tokens, DB key, install id removed
    expect(globalThis.__device.sqliteFiles.has('securechat.db')).toBe(false);
    expect(app.tokenStore.getCachedSession()).toBeNull();
    expect(await app.deviceId.getDeviceId()).toBe(deviceId);
  });

  it('still wipes everything locally when offline', async () => {
    await signIn(app);
    global.fetch = jest.fn(() => Promise.reject(new Error('offline')));

    await state().logout();

    expect(state().status).toBe('signedOut');
    expect(secureStoreKeys()).toEqual(['device.id']);
    expect(globalThis.__device.sqliteFiles.has('securechat.db')).toBe(false);
  });

  it('stays signed out after a restart', async () => {
    await signIn(app);
    mockApi({ 'POST /auth/logout': () => ({ status: 204 }) });
    await state().logout();

    jest.resetModules();
    app = loadApp();
    await state().initialize();

    expect(state().status).toBe('signedOut');
  });

  it('a new login after logout gets a fresh database key', async () => {
    await signIn(app);
    const firstKey = globalThis.__device.secureStore.get('db.key');
    mockApi({ 'POST /auth/logout': () => ({ status: 204 }) });
    await state().logout();

    await signIn(app, { tokens: makeTokens() });

    expect(globalThis.__device.secureStore.get('db.key')).not.toBe(firstKey);
  });
});
