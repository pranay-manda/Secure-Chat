/* global jest */
import { LIMITS } from '@secure-chat/shared/constants';

import { loadApp, mockApi, resetDevice, signIn } from './helpers';

/**
 * Contact discovery: address book read on the device, only normalized phone numbers sent
 * to POST /contacts/match in batches, matches shown with local names.
 */
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  Stack: { Screen: () => null },
  useFocusEffect: (effect) => require('react').useEffect(() => effect(), [effect]),
}));

const BOB_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL_ID = 'cccccccccccccccccccccccc';

let app;
let discovery;

const contacts = () => globalThis.__device.contacts;
function setPhoneBook(book, { status = 'granted', grantOnRequest = true } = {}) {
  globalThis.__device.contacts = {
    status,
    canAskAgain: status !== 'denied',
    grantOnRequest,
    book,
    requests: 0,
    reads: [],
  };
}

/** Fake POST /contacts/match: these numbers are registered. */
function registered(map) {
  return mockApi({
    'POST /contacts/match': ({ body }) => ({
      body: {
        matches: body.phoneNumbers
          .filter((n) => map[n])
          .map((n) => ({
            userId: map[n].id,
            phoneNumber: n,
            displayName: map[n].displayName ?? '',
          })),
      },
    }),
  });
}

beforeEach(async () => {
  jest.resetModules();
  resetDevice();
  globalThis.__device.contacts = undefined;
  app = loadApp();
  discovery = require('../src/contacts/contactDiscovery');
  await signIn(app);
});

describe('permission', () => {
  it('is never requested at app start or sign-in, only when discovery is entered', async () => {
    const Contacts = require('expo-contacts');
    await app.auth.useAuthStore.getState().initialize();
    expect(Contacts.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(Contacts.Contact.getAllDetails).not.toHaveBeenCalled();

    setPhoneBook([], { status: 'undetermined' });
    expect(await discovery.requestContactsPermission()).toEqual({
      status: 'granted',
      canAskAgain: true,
    });
    expect(contacts().requests).toBe(1);
  });

  it('reports a denial without reading contacts or calling the API', async () => {
    setPhoneBook([{ fullName: 'Bob', phones: [{ number: '+919812345678' }] }], {
      status: 'undetermined',
      grantOnRequest: false,
    });
    const calls = registered({});

    expect(await discovery.requestContactsPermission()).toEqual({
      status: 'denied',
      canAskAgain: false,
    });
    expect(contacts().reads).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('matching', () => {
  it('sends only normalized phone numbers and labels matches with local contact names', async () => {
    setPhoneBook([
      { fullName: 'Bob Kumar', phones: [{ number: '+91 98123 45678' }] },
      { fullName: 'Carol', phones: [{ number: '+1 (415) 555-0123' }] },
      { fullName: 'Not On App', phones: [{ number: '+91 98000 00001' }] },
    ]);
    const calls = registered({
      '+919812345678': { id: BOB_ID, displayName: 'Robert' },
      '+14155550123': { id: CAROL_ID },
    });

    const people = await discovery.discoverContacts();

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      phoneNumbers: ['+919812345678', '+14155550123', '+919800000001'],
    });
    // The local name wins over the account's display name; numbers are masked.
    expect(people).toEqual([
      {
        userId: BOB_ID,
        name: 'Bob Kumar',
        phoneNumber: '+919812345678',
        maskedPhone: '+91 ******5678',
      },
      {
        userId: CAROL_ID,
        name: 'Carol',
        phoneNumber: '+14155550123',
        maskedPhone: '+1 ******0123',
      },
    ]);
  });

  it('never sends contact names or anything but phone numbers', async () => {
    setPhoneBook([
      { fullName: 'Secret Name One', phones: [{ number: '+919812345678' }] },
      { fullName: 'Another Private Name', phones: [{ number: '+14155550123' }] },
    ]);
    const calls = registered({});

    await discovery.discoverContacts();

    const sent = JSON.stringify(calls.map((c) => c.body));
    expect(sent).not.toContain('Secret');
    expect(sent).not.toContain('Private');
    expect(Object.keys(calls[0].body)).toEqual(['phoneNumbers']);
    // Only the two fields needed are read from the address book.
    expect(contacts().reads[0].fields).toEqual(['fullName', 'phones']);
  });

  it('normalizes formats, removes duplicates and invalid numbers, excludes my own number', async () => {
    setPhoneBook([
      { fullName: 'Bob', phones: [{ number: '98123 45678' }, { number: '+91-98123-45678' }] },
      { fullName: 'Bob (work)', phones: [{ number: '+919812345678' }] },
      { fullName: 'Junk', phones: [{ number: '12' }, { number: 'abc' }, {}] },
      { fullName: 'Me', phones: [{ number: '+91 98765 43210' }] },
      { fullName: 'No phone', phones: [] },
    ]);
    const calls = registered({ '+919812345678': { id: BOB_ID } });

    const people = await discovery.discoverContacts({ myPhoneNumber: '+919876543210' });

    expect(calls[0].body.phoneNumbers).toEqual(['+919812345678']);
    expect(people.map((p) => [p.name, p.userId])).toEqual([['Bob', BOB_ID]]);
  });

  it('returns nothing and calls no API for an empty address book', async () => {
    setPhoneBook([]);
    const calls = registered({});
    expect(await discovery.discoverContacts()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('falls back to the account display name, then the masked number', async () => {
    setPhoneBook([
      { phones: [{ number: '+919812345678' }] },
      { fullName: '   ', phones: [{ number: '+14155550123' }] },
    ]);
    registered({
      '+919812345678': { id: BOB_ID, displayName: 'Robert' },
      '+14155550123': { id: CAROL_ID },
    });

    const names = (await discovery.discoverContacts()).map((p) => p.name).sort();
    expect(names).toEqual(['+1 ******0123', 'Robert']);
  });

  it('reads a large address book in pages and matches it in bounded batches', async () => {
    const book = Array.from({ length: 1234 }, (_, i) => ({
      fullName: `Person ${i}`,
      phones: [{ number: `+9198${String(10000000 + i)}` }],
    }));
    setPhoneBook(book);
    const calls = registered({ [`+9198${String(10000000 + 42)}`]: { id: BOB_ID } });

    const people = await discovery.discoverContacts();

    expect(contacts().reads.map((r) => r.offset)).toEqual([0, 500, 1000]);
    expect(calls.map((c) => c.body.phoneNumbers.length)).toEqual([500, 500, 234]);
    expect(Math.max(...calls.map((c) => c.body.phoneNumbers.length))).toBeLessThanOrEqual(
      LIMITS.CONTACT_MATCH_BATCH_MAX,
    );
    expect(people).toEqual([expect.objectContaining({ userId: BOB_ID, name: 'Person 42' })]);
  });

  it('stores nothing about the address book locally', async () => {
    setPhoneBook([{ fullName: 'Bob Kumar', phones: [{ number: '+919812345678' }] }]);
    registered({ '+919812345678': { id: BOB_ID } });

    await discovery.discoverContacts();

    const store = require('../src/messaging/messageStore');
    expect(await store.listConversations()).toEqual([]);
    const dbBytes = Buffer.from(globalThis.__device.sqliteFiles.get('securechat.db').db.export());
    expect(dbBytes.includes(Buffer.from('Bob Kumar'))).toBe(false);
  });
});

describe('naming chats that someone else started', () => {
  const store = () => require('../src/messaging/messageStore');

  it('names an incoming chat from the address book, once, without overwriting nicknames', async () => {
    // Bob messaged first: the chat exists but has no name. Carol's chat has my own nickname.
    await store().ensureConversation(BOB_ID);
    await store().ensureConversation(CAROL_ID, { title: 'My nickname for Carol' });
    setPhoneBook([
      { fullName: 'Bob Kumar', phones: [{ number: '+919812345678' }] },
      { fullName: 'Carol Contact', phones: [{ number: '+14155550123' }] },
    ]);
    const calls = registered({
      '+919812345678': { id: BOB_ID },
      '+14155550123': { id: CAROL_ID },
    });

    expect(await discovery.nameConversationsFromContacts()).toBe(1);

    expect((await store().getConversation(BOB_ID)).title).toBe('Bob Kumar');
    expect((await store().getConversation(CAROL_ID)).title).toBe('My nickname for Carol');
    // Nothing left to name: no second upload of the address book.
    expect(await discovery.nameConversationsFromContacts()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(contacts().requests).toBe(0); // never prompts
  });

  it('does nothing without Contacts permission (no prompt, no upload)', async () => {
    await store().ensureConversation(BOB_ID);
    setPhoneBook([{ fullName: 'Bob Kumar', phones: [{ number: '+919812345678' }] }], {
      status: 'undetermined',
    });
    const calls = registered({ '+919812345678': { id: BOB_ID } });

    expect(await discovery.nameConversationsFromContacts()).toBe(0);

    expect(contacts().requests).toBe(0);
    expect(contacts().reads).toEqual([]);
    expect(calls).toEqual([]);
    expect((await store().getConversation(BOB_ID)).title).toBeNull();
  });

  it('opening New Chat also names existing unnamed chats', async () => {
    await store().ensureConversation(BOB_ID);
    setPhoneBook([{ fullName: 'Bob Kumar', phones: [{ number: '+919812345678' }] }]);
    registered({ '+919812345678': { id: BOB_ID } });

    await discovery.discoverContacts();

    expect((await store().getConversation(BOB_ID)).title).toBe('Bob Kumar');
  });
});

describe('New Chat screen', () => {
  let React;
  let act;
  let create;
  beforeEach(() => {
    React = require('react');
    ({ act, create } = require('react-test-renderer'));
  });

  async function render() {
    const NewChat = require('../src/app/(app)/new-chat').default;
    let tree;
    await act(async () => {
      tree = create(React.createElement(NewChat));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    return tree;
  }
  const texts = (tree) =>
    tree.root
      .findAll((n) => typeof n.props.children === 'string')
      .map((n) => n.props.children)
      .join(' | ');
  const press = (tree, label) =>
    act(async () => {
      tree.root.find((n) => n.props.onPress && n.props.title === label).props.onPress();
    });

  it('shows contacts on Secure Chat and opens the existing chat flow on tap', async () => {
    const { router } = require('expo-router');
    setPhoneBook([{ fullName: 'Bob Kumar', phones: [{ number: '+919812345678' }] }], {
      status: 'undetermined',
    });
    registered({ '+919812345678': { id: BOB_ID } });

    const tree = await render();

    expect(contacts().requests).toBe(1); // asked on entering New Chat
    expect(texts(tree)).toContain('Contacts on Secure Chat');
    expect(texts(tree)).toContain('Bob Kumar');
    expect(texts(tree)).toContain('+91 ******5678');
    expect(texts(tree)).toContain('Search by Secure Chat ID');

    await act(async () => {
      tree.root.find((n) => n.props.testID === `contact-${BOB_ID}`).props.onPress();
    });
    expect(router.replace).toHaveBeenCalledWith(`/chat/${BOB_ID}`);
    const conversation = await require('../src/messaging/messageStore').getConversation(BOB_ID);
    expect(conversation).toMatchObject({ peerUserId: BOB_ID, title: 'Bob Kumar', locked: 0 });
  });

  it('explains a denied permission and offers Try again and the Secure Chat ID fallback', async () => {
    const { router } = require('expo-router');
    setPhoneBook([], { status: 'undetermined', grantOnRequest: false });

    const tree = await render();

    expect(texts(tree)).toContain(
      'Contacts permission is needed to find people you know on Secure Chat.',
    );
    expect(texts(tree)).toContain('Continue with Secure Chat ID');
    await press(tree, 'Continue with Secure Chat ID');
    expect(router.push).toHaveBeenCalledWith('/new-chat-id');
  });

  it('shows an empty state (with the ID fallback) when no contacts use Secure Chat', async () => {
    setPhoneBook([{ fullName: 'Nobody', phones: [{ number: '+919800000001' }] }]);
    registered({});

    const tree = await render();

    expect(texts(tree)).toContain('None of your contacts use Secure Chat yet');
    expect(texts(tree)).toContain('Search by Secure Chat ID');
  });

  it('shows a retryable error when the server cannot be reached', async () => {
    setPhoneBook([{ fullName: 'Bob', phones: [{ number: '+919812345678' }] }]);
    mockApi({
      'POST /contacts/match': () => {
        throw new Error('offline');
      },
    });

    const tree = await render();
    expect(texts(tree)).toContain('You’re offline');

    registered({ '+919812345678': { id: BOB_ID } });
    await press(tree, 'Try again');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(texts(tree)).toContain('Bob');
  });
});

describe('Secure Chat ID fallback', () => {
  it('still starts a chat from a typed user ID', async () => {
    const React = require('react');
    const { act, create } = require('react-test-renderer');
    const { router } = require('expo-router');
    const Screen = require('../src/app/(app)/new-chat-id').default;
    let tree;
    await act(async () => {
      tree = create(React.createElement(Screen));
    });
    const [idField] = tree.root.findAll((n) => n.props.testID === 'peer-id-input');
    await act(async () => idField.props.onChangeText(CAROL_ID));
    await act(async () => {
      tree.root.find((n) => n.props.onPress && n.props.title === 'Start chat').props.onPress();
    });

    expect(router.replace).toHaveBeenCalledWith(`/chat/${CAROL_ID}`);
  });
});
