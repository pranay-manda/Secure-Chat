/* global jest */
import { loadApp, mockApi, resetDevice, secureStoreKeys, signIn } from './helpers';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
// The EAS project id comes from app.json (extra.eas.projectId) in real builds.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { version: '0.1.0', extra: { eas: { projectId: globalThis.__easProjectId } } },
  },
}));
globalThis.__easProjectId = '28568eb0-c14d-4d1c-991a-8044e10b4067';

const TOKEN = 'ExponentPushToken[deviceToken_0000000001]';

let app;
let push;

beforeEach(async () => {
  jest.resetModules();
  resetDevice();
  globalThis.__device.notify = undefined;
  app = loadApp();
  push = require('../src/notifications/pushNotifications');
  await signIn(app);
});

const notify = () => globalThis.__device.notify;
const stored = () => JSON.parse(globalThis.__device.secureStore.get('push.registration') ?? 'null');
const pushTokenRoute = () => mockApi({ 'POST /devices/push-token': () => ({ status: 204 }) });

describe('push token registration', () => {
  it('asks for permission, gets the token and registers it with the API once', async () => {
    const calls = pushTokenRoute();

    expect(await push.registerForPushNotifications()).toBe('granted');
    expect(await push.registerForPushNotifications()).toBe('granted'); // unchanged: no API call

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ token: TOKEN });
    expect(calls[0].headers.Authorization).toMatch(/^Bearer /);
    expect(stored()).toMatchObject({ token: TOKEN });
    expect(push.usePushStore.getState().status).toBe('granted');

    await push.registerForPushNotifications({ force: true });
    expect(calls).toHaveLength(2);
  });

  it('respects a denied permission and never asks again when the system says no', async () => {
    const calls = pushTokenRoute();
    globalThis.__device.notify = {
      permission: { granted: false, canAskAgain: false },
      token: TOKEN,
      tokenListeners: new Set(),
      requested: 0,
      unregistered: 0,
    };

    expect(await push.registerForPushNotifications()).toBe('denied');
    expect(notify().requested).toBe(0); // no prompt once the user blocked it in system settings
    expect(calls).toHaveLength(0);
    expect(stored()).toBeNull();
    expect(push.usePushStore.getState().status).toBe('denied');

    // First launch (can still ask): the user is prompted once; declining also ends at denied.
    notify().permission = { granted: false, canAskAgain: true };
    expect(await push.registerForPushNotifications()).toBe('denied');
    expect(notify().requested).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('survives token generation failure and an unavailable backend, then recovers', async () => {
    await push.registerForPushNotifications(); // creates notify state
    globalThis.__device.secureStore.delete('push.registration');

    notify().tokenError = new Error('SERVICE_NOT_AVAILABLE');
    expect(await push.registerForPushNotifications()).toBe('error');
    delete notify().tokenError;

    mockApi({
      'POST /devices/push-token': () => {
        throw new Error('offline');
      },
    });
    expect(await push.registerForPushNotifications()).toBe('error');
    expect(stored()).toBeNull(); // not marked as registered

    const calls = pushTokenRoute();
    expect(await push.registerForPushNotifications()).toBe('granted');
    expect(calls).toHaveLength(1);
  });

  it('reports push as unavailable when the build has no EAS project id', async () => {
    const calls = pushTokenRoute();
    require('expo-constants').default.expoConfig.extra.eas.projectId = undefined;
    try {
      expect(await push.registerForPushNotifications()).toBe('unavailable');
      expect(calls).toHaveLength(0);
    } finally {
      require('expo-constants').default.expoConfig.extra.eas.projectId = globalThis.__easProjectId;
    }
  });

  it('does not loop when its own token fetch notifies the token listener', async () => {
    const calls = pushTokenRoute();
    const { getExpoPushTokenAsync } = require('expo-notifications');
    const stop = push.watchPushTokenChanges();

    await push.registerForPushNotifications();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls).toHaveLength(1);
    expect(getExpoPushTokenAsync.mock.calls.length).toBeLessThanOrEqual(2);
    stop();
  });

  it('re-registers when FCM rotates the token', async () => {
    const calls = pushTokenRoute();
    await push.registerForPushNotifications();
    const stop = push.watchPushTokenChanges();

    notify().token = 'ExponentPushToken[rotatedToken_0000000002]';
    for (const listener of notify().tokenListeners) listener({ type: 'android', data: 'fcm' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.map((c) => c.body.token)).toEqual([
      TOKEN,
      'ExponentPushToken[rotatedToken_0000000002]',
    ]);
    expect(stored().token).toBe('ExponentPushToken[rotatedToken_0000000002]');
    stop();
    expect(notify().tokenListeners.size).toBe(0);
  });
});

describe('notifications while the app is open', () => {
  it('shows no banner in the foreground (Pusher delivers), but does in the background', async () => {
    const { AppState } = require('react-native');
    const handler = globalThis.__notificationHandler;

    AppState.currentState = 'active';
    expect(await handler.handleNotification()).toMatchObject({ shouldShowBanner: false });
    AppState.currentState = 'background';
    expect(await handler.handleNotification()).toMatchObject({ shouldShowBanner: true });
  });
});

describe('tapping a notification', () => {
  const response = (identifier, data) => ({
    notification: { request: { identifier, content: { title: 'Secure Chat', data } } },
  });

  it('opens the conversation of the (locally decrypted) message, once', async () => {
    const { router } = require('expo-router');
    const { openFromNotification } = require('../src/notifications/useNotifications');
    await require('../src/crypto/signalStore').insertMessage({
      serverMessageId: 'srv-message-1',
      peerUserId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      direction: 'in',
      body: 'hi',
      status: 'received',
    });

    const tap = response('n-1', {
      type: 'new_message',
      messageId: 'srv-message-1',
      hasMessage: true,
    });
    expect(await openFromNotification(tap)).toBe('bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(await openFromNotification(tap)).toBeNull(); // same tap reported again: ignored
    expect(router.push.mock.calls).toEqual([['/chat/bbbbbbbbbbbbbbbbbbbbbbbb']]);

    await openFromNotification(response('n-2', { type: 'new_message', messageId: 'unknown' }));
    expect(router.push).toHaveBeenLastCalledWith('/');

    await openFromNotification(response('n-3', { type: 'something_else' }));
    expect(router.push).toHaveBeenCalledTimes(2);
  });
});

describe('logout', () => {
  it('removes the registration, invalidates the FCM token and keeps the secure wipe intact', async () => {
    pushTokenRoute();
    await push.registerForPushNotifications();
    expect(secureStoreKeys()).toContain('push.registration');

    mockApi({ 'POST /auth/logout': () => ({ status: 204 }) });
    await app.auth.useAuthStore.getState().logout();

    expect(secureStoreKeys()).toEqual(['device.id']);
    expect(notify().unregistered).toBe(1);
    expect(push.usePushStore.getState().status).toBe('unknown');
  });
});
