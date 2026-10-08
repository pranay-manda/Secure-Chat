/* global jest */
import { loadApp, mockApi, resetDevice, secureStoreKeys, signIn } from './helpers';

/**
 * Account deletion on the phone: the server deletes the account, then EVERYTHING local is
 * wiped (database + key, tokens, Signal identity, push registration, device id). If the server
 * did not confirm, nothing local is touched.
 */
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  Stack: { Screen: () => null },
}));

let app;
const state = () => app.auth.useAuthStore.getState();

/** A signed-in phone with messages, a Signal identity + session and a push registration. */
async function signedInWithData() {
  await signIn(app);
  const signalStore = require('../src/crypto/signalStore');
  const messages = require('../src/messaging/messageStore');
  await signalStore.saveIdentity({
    identityKeyPair: 'PRIVATE',
    identityKey: 'PUB',
    registrationId: 7,
  });
  await signalStore.saveSession('peer.1', 'session-record');
  await signalStore.saveSignedPreKey({ keyId: 1, record: 'signed-private' });
  await messages.ensureConversation('peer', { title: 'Bob', at: Date.now() });
  await signalStore.insertMessage({
    serverMessageId: 'm1',
    peerUserId: 'peer',
    direction: 'in',
    body: 'secret text',
    status: 'received',
  });
  globalThis.__device.secureStore.set('push.registration', '{"token":"ExponentPushToken[x]"}');
  return globalThis.__device.secureStore.get('device.id');
}

beforeEach(() => {
  jest.resetModules();
  resetDevice();
  app = loadApp();
});

describe('deleting the account', () => {
  it('deletes on the server, then wipes all local data and returns to sign-in', async () => {
    const oldDeviceId = await signedInWithData();
    const calls = mockApi({ 'DELETE /account': () => ({ status: 204 }) });

    await state().deleteAccount();

    expect(calls.map((c) => c.key)).toContain('DELETE /account');
    const request = calls.find((c) => c.key === 'DELETE /account');
    expect(request.headers.Authorization).toMatch(/^Bearer /);
    expect(request.body).toBeUndefined(); // the account comes from the session, not the request

    expect(state()).toMatchObject({ status: 'signedOut', user: null });
    expect(state().notice).toMatch(/deleted/i);
    // Database (messages, Signal sessions/pre-keys, chat state) and its key are gone.
    expect(globalThis.__device.sqliteFiles.has('securechat.db')).toBe(false);
    // SecureStore: no tokens, no Signal identity, no db key, no push registration.
    expect(secureStoreKeys()).toEqual(['device.id']);
    expect(globalThis.__device.secureStore.get('device.id')).not.toBe(oldDeviceId);
  });

  it('keeps everything if the server did not delete the account (error or offline)', async () => {
    await signedInWithData();
    const before = secureStoreKeys();

    mockApi({
      'DELETE /account': () => ({ status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE' } } }),
    });
    await expect(state().deleteAccount()).rejects.toMatchObject({ status: 503 });

    mockApi({
      'DELETE /account': () => {
        throw new TypeError('Network request failed');
      },
    });
    await expect(state().deleteAccount()).rejects.toMatchObject({ name: 'NetworkError' });

    expect(state().status).toBe('signedIn');
    expect(secureStoreKeys()).toEqual(before);
    expect(globalThis.__device.sqliteFiles.has('securechat.db')).toBe(true);
    const rows = await require('../src/crypto/signalStore').listMessages('peer');
    expect(rows.map((m) => m.body)).toEqual(['secret text']);
  });

  it('if the account is already gone (session rejected), the phone is still wiped', async () => {
    await signedInWithData();
    mockApi({
      'DELETE /account': () => ({ status: 401, body: { error: { code: 'UNAUTHENTICATED' } } }),
      'POST /auth/refresh': () => ({
        status: 401,
        body: { error: { code: 'INVALID_REFRESH_TOKEN' } },
      }),
    });

    await state()
      .deleteAccount()
      .catch(() => {});

    expect(state().status).toBe('signedOut');
    expect(globalThis.__device.sqliteFiles.has('securechat.db')).toBe(false);
    expect(secureStoreKeys()).toEqual(['device.id']);
  });
});

describe('Delete account screen', () => {
  let React;
  let act;
  let create;
  let Alert;
  beforeEach(() => {
    React = require('react');
    ({ act, create } = require('react-test-renderer'));
    ({ Alert } = require('react-native'));
  });

  it('warns that it is permanent and needs the typed word plus a final confirmation', async () => {
    await signIn(app);
    const deleteAccount = jest.fn(async () => {});
    app.auth.useAuthStore.setState({ deleteAccount });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const Screen = require('../src/app/(app)/delete-account').default;

    let tree;
    act(() => {
      tree = create(React.createElement(Screen));
    });
    const text = () => JSON.stringify(tree.toJSON());
    expect(text()).toMatch(/permanent/i);
    expect(text()).toMatch(/cannot be undone/i);

    const button = () =>
      tree.root.find((n) => n.props.accessibilityRole === 'button' && n.props.onPress);
    // Disabled until the confirmation word is typed.
    expect(button().props.disabled || button().props.accessibilityState?.disabled).toBeTruthy();
    const input = tree.root.find((n) => n.props.testID === 'delete-confirmation-input');
    act(() => input.props.onChangeText('delete')); // wrong case: still disabled
    expect(button().props.disabled || button().props.accessibilityState?.disabled).toBeTruthy();
    act(() => input.props.onChangeText('DELETE'));
    expect(button().props.disabled || button().props.accessibilityState?.disabled).toBeFalsy();

    // Pressing asks once more; only the destructive choice deletes.
    act(() => button().props.onPress());
    expect(deleteAccount).not.toHaveBeenCalled();
    const [title, , buttons] = alert.mock.calls.at(-1);
    expect(title).toMatch(/permanently/i);
    buttons.find((b) => b.text === 'Cancel').onPress?.();
    expect(deleteAccount).not.toHaveBeenCalled();
    await act(async () => buttons.find((b) => b.style === 'destructive').onPress());
    expect(deleteAccount).toHaveBeenCalledTimes(1);
  });
});
