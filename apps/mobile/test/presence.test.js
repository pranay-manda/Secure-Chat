/* global jest */
import { loadApp, mockApi, resetDevice, signIn } from './helpers';

/**
 * "Online" in a chat header: read from the API while the chat is open, shown only when the
 * other person's app is connected, and not flipped off by a single missed read.
 */
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  // The chat's header lives in the navigator's options: render it so the test can read it.
  Stack: {
    Screen: ({ options }) => {
      const React = require('react');
      if (!options?.headerTitle) return null;
      return React.createElement(React.Fragment, null, options.headerTitle());
    },
  },
  usePathname: () => '/',
  useLocalSearchParams: () => globalThis.__routeParams ?? {},
  useFocusEffect: (effect) => require('react').useEffect(() => effect(), [effect]),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const PEER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let server;

beforeEach(async () => {
  jest.resetModules();
  resetDevice();
  const app = loadApp();
  await signIn(app);
  server = { online: false };
  server.calls = mockApi({
    [`GET /presence?userIds=${PEER}`]: () => ({ body: { presence: { [PEER]: server.online } } }),
    'GET /calls/current': () => ({ body: { call: null } }),
  });
  await require('../src/messaging/messageStore').ensureConversation(PEER, { title: 'Bob' });
  require('../src/messaging/messagingEngine').useMessagingStore.setState({ online: true });
  globalThis.__routeParams = { peerUserId: PEER };
});

afterEach(() => {
  globalThis.__routeParams = undefined;
  jest.useRealTimers();
});

async function renderChat() {
  const React = require('react');
  const { act, create } = require('react-test-renderer');
  const Screen = require('../src/app/(app)/chat/[peerUserId]').default;
  let tree;
  await act(async () => {
    tree = create(React.createElement(Screen));
  });
  await act(async () => flush());
  const subtitle = () => tree.root.findByProps({ testID: 'chat-subtitle' }).props.children;
  return { tree, act, subtitle };
}

describe('online status in the chat header', () => {
  it('shows "Online" only while the other app is connected, and "Offline" otherwise', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const { tree, act, subtitle } = await renderChat();
    expect(subtitle()).toBe('Offline');
    expect(server.calls.filter((c) => c.key.startsWith('GET /presence'))).toHaveLength(1);

    server.online = true;
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    await act(async () => flush());
    expect(subtitle()).toBe('Online');

    // One "offline" answer is enough: the server already waits out a missed heartbeat.
    server.online = false;
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    await act(async () => flush());
    expect(subtitle()).toBe('Offline');

    // Typing overrides online/offline:
    const { handleTypingEvent } = require('../src/presence/usePresence');
    act(() => {
      handleTypingEvent({ fromUserId: PEER, typing: true });
    });
    expect(subtitle()).toBe('typing…');

    // Auto-expires back to offline:
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(subtitle()).toBe('Offline');

    // Nothing but the id goes to the server, and only this person's id is asked about.
    for (const call of server.calls.filter((c) => c.key.startsWith('GET /presence'))) {
      expect(call.key).toBe(`GET /presence?userIds=${PEER}`);
      expect(call.body).toBeUndefined();
    }
    await act(async () => tree.unmount());
  });

  it('shows a pushed change at once, without waiting for the next poll', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    server.online = true;
    const { tree, act, subtitle } = await renderChat();
    expect(subtitle()).toBe('Online');
    const reads = () => server.calls.filter((c) => c.key.startsWith('GET /presence')).length;
    const before = reads();

    const { handlePresenceEvent } = require('../src/presence/usePresence');
    await act(async () => handlePresenceEvent({ userId: PEER, online: false }));
    expect(subtitle()).toBe('Offline');
    await act(async () => handlePresenceEvent({ userId: PEER, online: true }));
    expect(subtitle()).toBe('Online');
    // Someone else's change, or a malformed event, changes nothing.
    await act(async () =>
      handlePresenceEvent({ userId: 'cccccccccccccccccccccccc', online: false }),
    );
    await act(async () => handlePresenceEvent({ userId: PEER, online: 'no' }));
    expect(subtitle()).toBe('Online');
    expect(reads()).toBe(before); // no extra request was needed
    await act(async () => tree.unmount());
  });

  it('re-reads as soon as the app comes back to the screen', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    server.online = true;
    const { AppState } = require('react-native');
    const listeners = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((event, fn) => {
      listeners.push(fn);
      return { remove() {} };
    });
    const { tree, act, subtitle } = await renderChat();
    expect(subtitle()).toBe('Online');
    server.online = false; // went offline while this phone was away
    await act(async () => listeners.forEach((fn) => fn('active')));
    await act(async () => flush());
    expect(subtitle()).toBe('Offline');
    spy.mockRestore();
    await act(async () => tree.unmount());
  });

  it('does not ask while this phone is offline, and leaves the screen cleanly', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    require('../src/messaging/messagingEngine').useMessagingStore.setState({ online: false });
    const { tree, act, subtitle } = await renderChat();
    expect(subtitle()).toBe('End-to-end encrypted');
    expect(server.calls.filter((c) => c.key.startsWith('GET /presence'))).toHaveLength(0);
    await act(async () => tree.unmount());
    await act(async () => jest.advanceTimersByTimeAsync(60_000));
    expect(server.calls.filter((c) => c.key.startsWith('GET /presence'))).toHaveLength(0);
  });
});
