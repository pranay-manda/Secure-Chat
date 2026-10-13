/* global jest */
import { loadApp, mockApi, resetDevice, signIn } from './helpers';

/**
 * WhatsApp-style search on the Chats tab: chats by name/message, contacts on CipherChat from the
 * address book (by name or number), and an exact typed number looked up on the server.
 */
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  // Render the header parts the screen sets, so the test can use the search field and icons.
  Stack: {
    Screen: ({ options }) => {
      const React = require('react');
      const part = (value) => (typeof value === 'function' ? value() : null);
      return React.createElement(
        React.Fragment,
        null,
        part(options?.headerLeft),
        part(options?.headerTitle),
        part(options?.headerRight),
      );
    },
  },
}));

const BOB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'cccccccccccccccccccccccc';
const DAN = 'dddddddddddddddddddddddd';
const ME = '+919876543210'; // helpers.USER

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let calls;
let registered;

beforeEach(async () => {
  jest.resetModules();
  jest.useRealTimers();
  resetDevice();
  globalThis.__device.contacts = undefined;
  const app = loadApp();
  await signIn(app);
  registered = {
    '+919811111111': { userId: CAROL, displayName: '' },
    '+919822222222': { userId: DAN, displayName: '' },
  };
  calls = mockApi({
    'POST /contacts/match': ({ body }) => ({
      body: {
        matches: body.phoneNumbers
          .filter((n) => registered[n])
          .map((n) => ({ phoneNumber: n, ...registered[n] })),
      },
    }),
  });
  await require('../src/messaging/messageStore').ensureConversation(BOB, { title: 'Bob' });
});

async function renderChats() {
  const React = require('react');
  const { act, create } = require('react-test-renderer');
  const Screen = require('../src/app/(app)/(tabs)/index').default;
  let tree;
  await act(async () => {
    tree = create(React.createElement(Screen));
  });
  await act(async () => flush());
  const find = (pred) => tree.root.findAll(pred)[0];
  const byLabel = (label) => find((n) => n.props.accessibilityLabel === label && n.props.onPress);
  const byTestId = (id) => find((n) => n.props.testID === id);
  const tap = async (node) => {
    await act(async () => node.props.onPress());
    await act(async () => flush());
  };
  const typeQuery = async (text) => {
    await act(async () => byTestId('chat-search-input').props.onChangeText(text));
    await act(async () => flush());
  };
  const texts = () =>
    tree.root
      .findAll((n) => typeof n.props.children === 'string')
      .map((n) => n.props.children)
      .join(' | ');
  const waitForLookup = async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 650)));
    await act(async () => flush());
  };
  return { tree, act, byLabel, byTestId, tap, typeQuery, texts, waitForLookup };
}

const matchRequests = () => calls.filter((c) => c.key === 'POST /contacts/match');

it('the search icon turns the header into a search field; Back closes it', async () => {
  const ui = await renderChats();
  expect(ui.texts()).toMatch(/Bob/);
  await ui.tap(ui.byLabel('Search chats'));
  expect(ui.byTestId('chat-search-input')).toBeDefined();
  await ui.typeQuery('bo');
  expect(ui.texts()).toMatch(/Chats/);
  expect(ui.texts()).toMatch(/Bob/);
  await ui.typeQuery('zzz');
  expect(ui.texts()).not.toMatch(/Bob/);
  await ui.tap(ui.byLabel('Close search'));
  expect(ui.byTestId('chat-search-input')).toBeUndefined();
  expect(ui.texts()).toMatch(/Bob/);
  await ui.act(async () => ui.tree.unmount());
});

it('finds contacts on CipherChat by name or number, and opens a named chat', async () => {
  globalThis.__device.contacts = {
    status: 'granted',
    canAskAgain: true,
    book: [
      { fullName: 'Carol', phones: [{ number: '+91 98111 11111' }] },
      { fullName: 'Eve (not on app)', phones: [{ number: '+91 98333 33333' }] },
    ],
    requests: 0,
    reads: [],
  };
  const ui = await renderChats();
  await ui.tap(ui.byLabel('Search chats'));
  await ui.typeQuery('car');
  expect(ui.texts()).toMatch(/Contacts on CipherChat/);
  expect(ui.byTestId(`search-contact-${CAROL}`)).toBeDefined();
  expect(ui.texts()).not.toMatch(/Eve/);

  await ui.typeQuery('11111'); // part of her number works too
  expect(ui.byTestId(`search-contact-${CAROL}`)).toBeDefined();
  expect(matchRequests()).toHaveLength(1); // the address book was checked once per search

  await ui.tap(ui.byTestId(`search-contact-${CAROL}`));
  const conversation = await require('../src/messaging/messageStore').getConversation(CAROL);
  expect(conversation.title).toBe('Carol');
  expect(require('expo-router').router.push).toHaveBeenCalledWith(`/chat/${CAROL}`);
  await ui.act(async () => ui.tree.unmount());
});

it('a typed phone number is looked up on the server: found → opens a chat', async () => {
  const ui = await renderChats();
  await ui.tap(ui.byLabel('Search chats'));
  await ui.typeQuery('98222 22222');
  await ui.waitForLookup();
  expect(matchRequests().at(-1).body).toEqual({ phoneNumbers: ['+919822222222'] });
  expect(ui.byTestId('search-number-result')).toBeDefined();
  await ui.tap(ui.byTestId('search-number-result'));
  const conversation = await require('../src/messaging/messageStore').getConversation(DAN);
  expect(conversation.title).toMatch(/98222/);
  expect(require('expo-router').router.push).toHaveBeenCalledWith(`/chat/${DAN}`);
  await ui.act(async () => ui.tree.unmount());
});

it('an unknown number says so; typing waits before asking (one request)', async () => {
  const ui = await renderChats();
  await ui.tap(ui.byLabel('Search chats'));
  for (const partial of ['9844', '984444', '98444444', '9844444444']) await ui.typeQuery(partial);
  await ui.waitForLookup();
  expect(matchRequests()).toHaveLength(1);
  expect(ui.byTestId('search-number-none')).toBeDefined();
  await ui.act(async () => ui.tree.unmount());
});

it('your own number is recognised without asking the server', async () => {
  const ui = await renderChats();
  await ui.tap(ui.byLabel('Search chats'));
  await ui.typeQuery(ME);
  await ui.waitForLookup();
  expect(ui.byTestId('search-number-self')).toBeDefined();
  expect(matchRequests()).toHaveLength(0);
  await ui.act(async () => ui.tree.unmount());
});

it('asks for Contacts permission only when the user taps "Allow"', async () => {
  globalThis.__device.contacts = {
    status: 'undetermined',
    canAskAgain: true,
    grantOnRequest: true,
    book: [{ fullName: 'Carol', phones: [{ number: '+91 98111 11111' }] }],
    requests: 0,
    reads: [],
  };
  const ui = await renderChats();
  await ui.tap(ui.byLabel('Search chats'));
  await ui.typeQuery('car');
  expect(globalThis.__device.contacts.requests).toBe(0);
  expect(ui.byTestId('search-allow-contacts')).toBeDefined();
  await ui.tap(ui.byTestId('search-allow-contacts'));
  await ui.act(async () => flush());
  expect(globalThis.__device.contacts.requests).toBe(1);
  expect(ui.byTestId(`search-contact-${CAROL}`)).toBeDefined();
  await ui.act(async () => ui.tree.unmount());
});
