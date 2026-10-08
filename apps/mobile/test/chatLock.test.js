/* global jest */
import { loadApp, mockApi, PHONE, resetDevice, signIn } from './helpers';

/**
 * Chat Lock: local access control for conversations. Authentication is the OS prompt
 * (mocked in setup.js); lock state lives in the encrypted local database only.
 */
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => globalThis.__routeParams ?? {},
  // Rendered screens are always focused in these tests.
  useFocusEffect: (effect) => require('react').useEffect(() => effect(), [effect]),
}));

const ALICE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'bbbbbbbbbbbbbbbbbbbbbbbb';

let app;
let lock;
let store;
let appStateListeners;

/** Loads the app modules as after a cold start, capturing AppState listeners. */
function boot() {
  jest.resetModules();
  appStateListeners = [];
  const { AppState } = require('react-native');
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    appStateListeners.push(listener);
    return { remove() {} };
  });
  app = loadApp();
  lock = require('../src/security/chatLock');
  store = require('../src/messaging/messageStore');
}

const auth = () =>
  (globalThis.__device.auth ??= { level: 3, types: [1], results: [], prompts: [] });
const nextAuth = (...results) => auth().results.push(...results);
const setAppState = (state) => appStateListeners.forEach((listener) => listener(state));

async function addChat(peer, body, title = null) {
  await store.ensureConversation(peer, { title, at: Date.now() });
  await require('../src/crypto/signalStore').insertMessage({
    serverMessageId: `srv-${peer}-${body}`,
    peerUserId: peer,
    direction: 'in',
    body,
    status: 'received',
  });
}

beforeEach(async () => {
  resetDevice();
  globalThis.__device.auth = undefined;
  globalThis.__device.screenCapture = undefined;
  boot();
  await signIn(app);
  await addChat(ALICE, 'hello from alice', 'Alice');
  await addChat(BOB, 'secret plan from bob', 'Bob');
});

describe('locking and unlocking', () => {
  it('locks a chat after successful authentication and hides it from the chat list', async () => {
    const result = await lock.lockConversation(BOB);

    expect(result).toEqual({ ok: true });
    expect(auth().prompts).toHaveLength(1);
    expect(auth().prompts[0]).toMatchObject({ disableDeviceFallback: false });
    expect(await store.isConversationLocked(BOB)).toBe(true);

    const visible = await store.listConversations();
    expect(visible.map((c) => c.peerUserId)).toEqual([ALICE]);
    expect(JSON.stringify(visible)).not.toContain('secret plan');
    expect(JSON.stringify(visible)).not.toContain('Bob');

    // Only existence and "has unread" are revealed before authentication.
    expect(await store.lockedChatsSummary()).toEqual({ total: 1, hasUnread: true });
    const lockedList = await store.listConversations({ locked: true });
    expect(lockedList.map((c) => c.peerUserId)).toEqual([BOB]);
  });

  it('does not lock when authentication fails, is cancelled, or the device has no screen lock', async () => {
    nextAuth({ success: false, error: 'authentication_failed' });
    expect(await lock.lockConversation(BOB)).toEqual({ ok: false, error: 'FAILED' });

    nextAuth({ success: false, error: 'user_cancel' });
    expect(await lock.lockConversation(BOB)).toEqual({ ok: false, error: 'CANCELLED' });

    auth().level = 0; // no fingerprint/face and no PIN/pattern/password on the device
    const prompts = auth().prompts.length;
    expect(await lock.lockConversation(BOB)).toEqual({ ok: false, error: 'NO_DEVICE_LOCK' });
    expect(auth().prompts).toHaveLength(prompts); // no prompt: nothing to verify against
    expect(lock.chatLockErrorMessage('NO_DEVICE_LOCK')).toMatch(/screen lock/);

    expect(await store.isConversationLocked(BOB)).toBe(false);
  });

  it('unlocks only after successful authentication', async () => {
    await lock.lockConversation(BOB);

    nextAuth({ success: false, error: 'lockout' });
    expect(await lock.unlockConversation(BOB)).toEqual({ ok: false, error: 'LOCKOUT' });
    expect(await store.isConversationLocked(BOB)).toBe(true);

    expect(await lock.unlockConversation(BOB)).toEqual({ ok: true });
    expect(await store.isConversationLocked(BOB)).toBe(false);
    expect((await store.listConversations()).map((c) => c.peerUserId).sort()).toEqual([ALICE, BOB]);
  });

  it('keeps independent lock states for multiple chats', async () => {
    const carol = 'cccccccccccccccccccccccc';
    await addChat(carol, 'hi from carol', 'Carol');

    await lock.lockConversation(BOB);
    await lock.lockConversation(carol);
    await lock.unlockConversation(BOB);

    expect(await store.isConversationLocked(ALICE)).toBe(false);
    expect(await store.isConversationLocked(BOB)).toBe(false);
    expect(await store.isConversationLocked(carol)).toBe(true);
    expect(await store.lockedChatsSummary()).toMatchObject({ total: 1 });
  });
});

describe('unlock session', () => {
  it('a locked chat cannot be shown until the owner authenticates; backgrounding re-locks', async () => {
    await lock.lockConversation(BOB);
    lock.relockChats();

    expect(await lock.canShowConversation(ALICE)).toBe(true); // unlocked chats: no prompt
    expect(await lock.canShowConversation(BOB)).toBe(false);

    nextAuth({ success: false, error: 'authentication_failed' });
    expect((await lock.unlockChats()).ok).toBe(false);
    expect(await lock.canShowConversation(BOB)).toBe(false);

    expect((await lock.unlockChats()).ok).toBe(true);
    expect(await lock.canShowConversation(BOB)).toBe(true);

    setAppState('background');
    expect(await lock.canShowConversation(BOB)).toBe(false);
    expect(await lock.canShowConversation(ALICE)).toBe(true);
  });

  it('screens re-locking at the same time share one OS prompt', async () => {
    await lock.lockConversation(BOB);
    lock.relockChats();
    const before = auth().prompts.length;

    const [a, b] = await Promise.all([lock.unlockChats('first'), lock.unlockChats('second')]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(auth().prompts.length - before).toBe(1);
    expect(lock.isChatLockSessionUnlocked()).toBe(true);
  });

  it('lock state survives restart and force-close; the unlock session does not', async () => {
    await lock.lockConversation(BOB);
    expect(lock.isChatLockSessionUnlocked()).toBe(true); // the owner just authenticated

    boot(); // force-close + relaunch: memory gone, encrypted storage kept
    await app.auth.useAuthStore.getState().initialize();

    expect(app.auth.useAuthStore.getState().status).toBe('signedIn');
    expect(await store.isConversationLocked(BOB)).toBe(true);
    expect(lock.isChatLockSessionUnlocked()).toBe(false);
    expect(await lock.canShowConversation(BOB)).toBe(false);
  });

  it('logout removes the lock state together with all local messages', async () => {
    await lock.lockConversation(BOB);
    mockApi({ 'POST /auth/logout': () => ({ status: 204 }) });
    await app.auth.useAuthStore.getState().logout();

    expect(globalThis.__device.sqliteFiles.has('securechat.db')).toBe(false);
    boot();
    await signIn(app);
    expect(await store.lockedChatsSummary()).toEqual({ total: 0, hasUnread: false });
    expect(await store.isConversationLocked(BOB)).toBe(false);
  });
});

describe('ChatLockGate (chat screen protection)', () => {
  // Loaded per test from the same module registry as the app (boot() resets it).
  let React;
  let act;
  let create;
  beforeEach(() => {
    React = require('react');
    ({ act, create } = require('react-test-renderer'));
  });

  function renderGate(peer, onContentMount) {
    const { ChatLockGate } = require('../src/components/ChatLockGate');
    // Stands in for ChatContent: the only component that reads messages from the database.
    function Content() {
      React.useEffect(() => {
        onContentMount();
        store.listChatMessages(peer);
      }, []);
      return null;
    }
    let tree;
    act(() => {
      tree = create(
        React.createElement(ChatLockGate, { peerUserId: peer }, React.createElement(Content)),
      );
    });
    return tree;
  }
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const gateShown = (tree) =>
    tree.root.findAll((n) => n.props.testID === 'chat-lock-gate').length > 0;

  it('never mounts or loads a locked chat before authentication', async () => {
    await lock.lockConversation(BOB);
    lock.relockChats();
    const readMessages = jest.spyOn(store, 'listChatMessages');
    const mounted = jest.fn();

    nextAuth({ success: false, error: 'user_cancel' }); // the automatic prompt is cancelled
    const tree = renderGate(BOB, mounted);
    await settle();

    expect(gateShown(tree)).toBe(true);
    expect(mounted).not.toHaveBeenCalled();
    expect(readMessages).not.toHaveBeenCalled();
    expect(auth().prompts).toHaveLength(2); // lock + the gate's one automatic prompt
    expect(JSON.stringify(tree.toJSON())).not.toMatch(/secret plan|Bob/);

    // The owner taps Unlock and authenticates: now the content mounts and is protected.
    const button = tree.root.find((n) => n.props.accessibilityRole === 'button' && n.props.onPress);
    await act(async () => {
      button.props.onPress();
    });
    await settle();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(readMessages).toHaveBeenCalledWith(BOB);
    expect([...globalThis.__device.screenCapture]).toEqual([`chat-lock:${BOB}`]);

    // App goes to the background: the content is unmounted again.
    await act(async () => setAppState('background'));
    await settle();
    expect(gateShown(tree)).toBe(true);
    expect(globalThis.__device.screenCapture.size).toBe(0);
  });

  it('a locked chat’s security code and "Security code changed" warning appear only after authentication', async () => {
    // Bob's security code changed (new identity key recorded, not trusted).
    const native = require('../modules/signal-protocol').getSignalNative();
    const signalStore = require('../src/crypto/signalStore');
    await signalStore.saveIdentity(await native.generateIdentity());
    const oldKey = (await native.generateIdentity()).identityKey;
    const newKey = (await native.generateIdentity()).identityKey;
    const address = signalStore.addressOf(BOB);
    await signalStore.savePeerIdentityIfNew(address, oldKey);
    await signalStore.recordIdentityChange(BOB, address, oldKey, newKey);
    await lock.lockConversation(BOB);
    lock.relockChats();

    nextAuth({ success: false, error: 'user_cancel' });
    globalThis.__routeParams = { peerUserId: BOB };
    const SecurityCodeScreen = require('../src/app/(app)/security-code/[peerUserId]').default;
    let tree;
    act(() => {
      tree = create(React.createElement(SecurityCodeScreen));
    });
    await settle();

    expect(gateShown(tree)).toBe(true);
    const before = JSON.stringify(tree.toJSON());
    expect(before).not.toMatch(/\d{5}|Security code|Bob|Accept/);

    const button = tree.root.find((n) => n.props.accessibilityRole === 'button' && n.props.onPress);
    await act(async () => {
      button.props.onPress();
    });
    for (let i = 0; i < 10 && gateShown(tree); i += 1) await settle();
    for (
      let i = 0;
      i < 20 && !tree.root.findAll((n) => n.props.testID === 'security-code').length;
      i += 1
    ) {
      await settle();
    }
    const after = JSON.stringify(tree.toJSON());
    expect(after).toMatch(/Security code changed/);
    expect(after).toMatch(/Accept new security code/);
    expect(after.match(/\d{5}/g).length).toBeGreaterThanOrEqual(12);
    globalThis.__routeParams = undefined;
  });

  it('shows unlocked chats immediately with no prompt', async () => {
    const mounted = jest.fn();
    const tree = renderGate(ALICE, mounted);
    await settle();

    expect(gateShown(tree)).toBe(false);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(auth().prompts).toHaveLength(0);
  });
});

describe('notifications and locked chats', () => {
  it('a tap on a locked chat’s notification opens the chat route, which is gated', async () => {
    const { router } = require('expo-router');
    await lock.lockConversation(BOB);
    lock.relockChats();
    jest.spyOn(require('../src/messaging/messagingEngine'), 'requestSync').mockResolvedValue();
    const routing = require('../src/notifications/notificationRouting');

    routing.captureResponse({
      notification: {
        request: {
          identifier: 'n-locked',
          content: {
            title: 'Secure Chat',
            body: 'New message',
            data: {
              type: 'new_message',
              messageId: `srv-${BOB}-secret plan from bob`,
              hasMessage: true,
            },
          },
        },
      },
    });
    await routing.processPendingTaps();

    expect(router.push).toHaveBeenCalledWith(`/chat/${BOB}`);
    expect(await lock.canShowConversation(BOB)).toBe(false); // the gate will ask first
  });

  it('nothing about chat locks is sent to the server', async () => {
    const calls = mockApi({});
    await lock.lockConversation(BOB);
    await lock.unlockConversation(BOB);
    await lock.lockConversation(ALICE);
    expect(calls).toEqual([]);
    expect(PHONE).toBeTruthy();
  });
});
