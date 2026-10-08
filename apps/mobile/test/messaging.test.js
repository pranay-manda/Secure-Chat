/* global jest */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { LIMITS } from '@secure-chat/shared/constants';

/**
 * Phase 3B: two complete app instances (A and B), each with its own SecureStore, SQLCipher DB,
 * messaging engine and Pusher connection, against an in-memory backend that implements the
 * real API contract (idempotent sends, per-device seq, acks, receipts, channel auth).
 * Crypto is the official libsignal (see mocks/signalNativeMock.js).
 */
// Two app instances plus real libsignal in a worker process: allow for a slow cold start.
jest.setTimeout(30_000);

const USERS = {
  A: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', phone: '+919876543210', deviceId: null },
  B: { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', phone: '+919812345678', deviceId: null },
};
const PUSHER_KEY = 'public-pusher-key';
const MESSAGE_FIELDS = [
  'recipientUserId',
  'recipientDeviceId',
  'clientMessageId',
  'type',
  'ciphertext',
];

let storage;
let apps;
let server;

const freshStorage = () => ({
  secureStore: new Map(),
  sqliteFiles: new Map(),
  sqliteBroken: false,
});
const nameOf = (userId) => Object.keys(USERS).find((k) => USERS[k].id === userId);

function boot(name) {
  globalThis.__device = storage[name];
  jest.isolateModules(() => {
    apps[name] = {
      auth: require('../src/auth/authStore'),
      signal: require('../src/crypto/signalService'),
      engine: require('../src/messaging/messagingEngine'),
      messages: require('../src/messaging/messageStore'),
      store: require('../src/crypto/signalStore'),
      db: require('../src/db/database'),
    };
  });
  return apps[name];
}

/** Lets a device finish all background work (realtime auth, syncs, event handling). */
async function settle(name) {
  globalThis.__device = storage[name];
  for (let i = 0; i < 4; i += 1) {
    await storage[name].pusher?.ready;
    await apps[name].engine.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Runs `fn` as device `name` and waits until that device is idle again. */
async function as(name, fn) {
  globalThis.__device = storage[name];
  const result = await fn(apps[name]);
  await settle(name);
  return result;
}

/** Pushes queued realtime events into a device's Pusher connection (missed if disconnected). */
async function deliverRealtime(name) {
  globalThis.__device = storage[name];
  const queued = server.realtimeQueue.filter((e) => e.device === name);
  server.realtimeQueue = server.realtimeQueue.filter((e) => e.device !== name);
  for (const e of queued) {
    const delivered = storage[name].pusher?.deliver(e.channel, e.event, e.data);
    if (delivered) server.realtimeDelivered.push(e);
  }
  await settle(name);
  return queued.length;
}

const conversation = (name, peer) =>
  as(name, (app) => app.messages.listChatMessages(USERS[peer].id));

function createServer() {
  const state = {
    devices: {},
    messages: [], // { id, senderUserId, senderDeviceId, clientMessageId, recipientUserId, deliveredAt, readAt }
    envelopes: [],
    seq: {},
    requests: [],
    published: [],
    realtimeQueue: [],
    realtimeDelivered: [],
    failNextPost: 0,
  };
  const channelOf = (userId) => `private-device-${USERS[nameOf(userId)].deviceId}`;
  const publish = (userId, event, data) => {
    const e = { device: nameOf(userId), channel: channelOf(userId), event, data };
    state.published.push(e);
    state.realtimeQueue.push(e);
  };
  const statusOf = (m) => (m.readAt ? 'read' : m.deliveredAt ? 'delivered' : 'sent');
  const userByToken = (headers) =>
    Object.keys(USERS).find((k) => headers.Authorization === `Bearer token-${k}`);

  const handlers = [
    [
      'POST',
      /^\/auth\/otp\/verify$/,
      ({ body }) => {
        const key = Object.keys(USERS).find((k) => USERS[k].phone === body.phoneNumber);
        USERS[key].deviceId = body.device.deviceId;
        // Like the API: a login clears the device's registered keys (fresh ones follow).
        delete state.devices[USERS[key].id];
        return {
          body: {
            user: { id: USERS[key].id, phoneNumber: USERS[key].phone, isNew: false },
            device: { deviceId: body.device.deviceId },
            tokens: {
              accessToken: `token-${key}`,
              accessTokenExpiresIn: 900,
              refreshToken: `${'a'.repeat(24)}.${'r'.repeat(43)}`,
              refreshTokenExpiresAt: new Date(Date.now() + 864e5).toISOString(),
            },
          },
        };
      },
    ],
    [
      'GET',
      /^\/keys\/status$/,
      ({ me }) => {
        const d = state.devices[USERS[me].id];
        return {
          body: {
            status: { registered: Boolean(d?.signal), oneTimePreKeyCount: d?.oneTime.length ?? 0 },
          },
        };
      },
    ],
    [
      'PUT',
      /^\/keys$/,
      ({ me, body }) => {
        const { oneTimePreKeys = [], ...signal } = body;
        state.devices[USERS[me].id] = {
          deviceId: USERS[me].deviceId,
          signal,
          oneTime: oneTimePreKeys,
        };
        return {
          body: { status: { registered: true, oneTimePreKeyCount: oneTimePreKeys.length } },
        };
      },
    ],
    [
      'GET',
      /^\/keys\/bundle\/(\w+)$/,
      ({ match }) => {
        const d = state.devices[match[1]];
        if (!d?.signal) return { status: 404, body: { error: { code: 'KEYS_NOT_REGISTERED' } } };
        return {
          body: {
            bundle: {
              userId: match[1],
              deviceId: d.deviceId,
              signalDeviceId: 1,
              ...d.signal,
              oneTimePreKey: d.oneTime.shift() ?? null,
            },
          },
        };
      },
    ],
    [
      'POST',
      /^\/messages$/,
      ({ me, body }) => {
        const fields = Object.keys(body).filter((k) => k !== 'recipientRegistrationId');
        if (fields.sort().join() !== [...MESSAGE_FIELDS].sort().join()) {
          return { status: 400, body: { error: { code: 'VALIDATION_ERROR' } } };
        }
        if (state.failNextPost > 0) {
          state.failNextPost -= 1;
          return { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE' } } };
        }
        const sender = USERS[me];
        const existing = state.messages.find(
          (m) => m.senderDeviceId === sender.deviceId && m.clientMessageId === body.clientMessageId,
        );
        if (existing) {
          return {
            body: {
              messageId: existing.id,
              seq: existing.seq,
              status: statusOf(existing),
              duplicate: true,
            },
          };
        }
        const recipient = USERS[nameOf(body.recipientUserId)];
        const recipientKeys = state.devices[recipient.id];
        if (
          !recipientKeys?.signal ||
          recipientKeys.deviceId !== body.recipientDeviceId ||
          (body.recipientRegistrationId != null &&
            recipientKeys.signal.registrationId !== body.recipientRegistrationId)
        ) {
          return { status: 409, body: { error: { code: 'STALE_RECIPIENT_DEVICE' } } };
        }
        state.seq[recipient.id] = (state.seq[recipient.id] ?? 0) + 1;
        const seq = state.seq[recipient.id];
        const id = `${'m'.repeat(18)}${String(state.messages.length + 1).padStart(6, '0')}`;
        const message = {
          id,
          seq,
          senderUserId: sender.id,
          senderDeviceId: sender.deviceId,
          clientMessageId: body.clientMessageId,
          recipientUserId: recipient.id,
          deliveredAt: null,
          readAt: null,
        };
        state.messages.push(message);
        const envelope = {
          envelopeId: `env-${id}`,
          seq,
          messageId: id,
          senderUserId: sender.id,
          senderDeviceId: sender.deviceId,
          senderSignalDeviceId: 1,
          type: body.type,
          ciphertext: body.ciphertext,
          createdAt: new Date().toISOString(),
        };
        state.envelopes.push({ ...envelope, recipientUserId: recipient.id, delivered: false });
        const inline = JSON.stringify(envelope).length <= LIMITS.PUSHER_INLINE_PAYLOAD_BYTES;
        const { envelopeId } = envelope;
        publish(
          recipient.id,
          'envelope',
          inline ? { envelopeId, seq, inline: true, envelope } : { envelopeId, seq, inline: false },
        );
        return { status: 201, body: { messageId: id, seq, status: 'sent', duplicate: false } };
      },
    ],
    [
      'GET',
      /^\/messages\/envelopes\?after=(\d+)$/,
      ({ me, match }) => ({
        body: {
          envelopes: state.envelopes
            .filter(
              (e) => e.recipientUserId === USERS[me].id && e.seq > Number(match[1]) && !e.delivered,
            )
            .slice(0, LIMITS.PAGE_SIZE_DEFAULT)
            .map(({ recipientUserId, delivered, ...e }) => e),
        },
      }),
    ],
    [
      'POST',
      /^\/messages\/envelopes\/ack$/,
      ({ me, body }) => {
        const now = new Date().toISOString();
        const acked = state.envelopes.filter(
          (e) => e.recipientUserId === USERS[me].id && e.seq <= body.upToSeq && !e.delivered,
        );
        for (const e of acked) {
          e.delivered = true;
          const m = state.messages.find((x) => x.id === e.messageId);
          m.deliveredAt ??= now;
          publish(m.senderUserId, 'receipt', {
            receipts: [{ messageId: m.id, status: 'delivered', at: now }],
          });
        }
        return { body: { acknowledged: acked.length } };
      },
    ],
    [
      'POST',
      /^\/messages\/read$/,
      ({ me, body }) => {
        const now = new Date().toISOString();
        let updated = 0;
        for (const id of body.messageIds) {
          const m = state.messages.find((x) => x.id === id && x.recipientUserId === USERS[me].id);
          if (!m || m.readAt) continue;
          m.deliveredAt ??= now;
          m.readAt = now;
          updated += 1;
          publish(m.senderUserId, 'receipt', {
            receipts: [{ messageId: m.id, status: 'read', at: now }],
          });
        }
        return { body: { updated } };
      },
    ],
    [
      'POST',
      /^\/messages\/status$/,
      ({ me, body }) => ({
        body: {
          statuses: state.messages
            .filter((m) => body.messageIds.includes(m.id) && m.senderUserId === USERS[me].id)
            .map((m) => ({
              messageId: m.id,
              status: statusOf(m),
              deliveredAt: m.deliveredAt,
              readAt: m.readAt,
            })),
        },
      }),
    ],
    [
      'GET',
      /^\/pusher\/config$/,
      ({ me }) => ({
        body: {
          realtime: { key: PUSHER_KEY, cluster: 'ap2' },
          channel: `private-device-${USERS[me].deviceId}`,
        },
      }),
    ],
    [
      'POST',
      /^\/pusher\/auth$/,
      ({ me, body }) =>
        body.channelName === `private-device-${USERS[me].deviceId}`
          ? { body: { auth: `${PUSHER_KEY}:signature-for-${body.socketId}` } }
          : { status: 403, body: { error: { code: 'FORBIDDEN' } } },
    ],
    ['POST', /^\/auth\/logout$/, () => ({ status: 204 })],
  ];

  global.fetch = jest.fn(async (url, init = {}) => {
    if (globalThis.__device.offline) throw new TypeError('Network request failed');
    const urlPath = url.replace('http://api.test', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.requests.push({ method, path: urlPath, body: init.body ?? '' });
    for (const [m, re, handler] of handlers) {
      const match = m === method && re.exec(urlPath);
      if (match) {
        const res = handler({ body, match, me: userByToken(init.headers ?? {}) });
        return {
          status: res.status ?? 200,
          json: async () => res.body ?? null,
          headers: { get: () => null },
        };
      }
    }
    throw new Error(`Unexpected request ${method} ${urlPath}`);
  });
  return state;
}

async function signInAndStart(name) {
  await as(name, async (app) => {
    await app.auth.useAuthStore.getState().verifyOtp(USERS[name].phone, '123456');
    await app.signal.ensureKeysRegistered();
    await app.engine.startMessaging(USERS[name].id);
  });
}

const send = (from, to, text) =>
  as(from, (app) => app.engine.sendMessage(USERS[from].id, USERS[to].id, text));

beforeEach(async () => {
  storage = { A: freshStorage(), B: freshStorage() };
  apps = {};
  server = createServer();
  boot('A');
  boot('B');
  await signInAndStart('A');
  await signInAndStart('B');
});

afterEach(() => {
  for (const name of ['A', 'B']) {
    globalThis.__device = storage[name];
    apps[name].engine.stopMessaging();
  }
});

describe('conversations', () => {
  it('creates a conversation locally with an optional nickname', async () => {
    // Spaces/punctuation cannot occur in base64 key material, so the leak check is exact.
    const nickname = 'Bob (work phone)';
    await as('A', (app) => app.engine.createConversation(USERS.B.id, `  ${nickname}  `));

    const list = await as('A', (app) => app.messages.listConversations());
    expect(list).toEqual([
      expect.objectContaining({
        peerUserId: USERS.B.id,
        title: nickname,
        lastBody: null,
        unread: 0,
      }),
    ]);
    // Local only: nothing about the conversation or nickname was sent to the server.
    expect(server.requests.map((r) => r.body).join()).not.toContain(nickname);
  });
});

describe('send and receive through Pusher', () => {
  it('A sends "Hello": stored locally, encrypted, posted as ciphertext only', async () => {
    await send('A', 'B', 'Hello');

    const post = server.requests.find((r) => r.method === 'POST' && r.path === '/messages');
    expect(post.body).not.toContain('Hello');
    // Plus the recipient's public registration id (lets the server spot re-registered keys).
    expect(Object.keys(JSON.parse(post.body)).sort()).toEqual(
      [...MESSAGE_FIELDS, 'recipientRegistrationId'].sort(),
    );

    const [sent] = await conversation('A', 'B');
    expect(sent).toMatchObject({ direction: 'out', body: 'Hello', status: 'sent' });
    expect(await as('A', (app) => app.messages.loadOutbox(sent.clientMessageId))).toBeNull();
  });

  it('B receives the Pusher event, decrypts locally, stores and lists "Hello", then acks', async () => {
    await send('A', 'B', 'Hello');
    expect(storage.B.pusher.auths).toEqual([
      {
        channel: `private-device-${USERS.B.deviceId}`,
        auth: expect.objectContaining({ auth: expect.any(String) }),
      },
    ]);

    await deliverRealtime('B');

    const [received] = await conversation('B', 'A');
    expect(received).toMatchObject({ direction: 'in', body: 'Hello' });
    const chats = await as('B', (app) => app.messages.listConversations());
    expect(chats[0]).toMatchObject({ peerUserId: USERS.A.id, lastBody: 'Hello', unread: 1 });
    expect(server.envelopes[0].delivered).toBe(true);
  });

  it('updates A to delivered, then read when B opens the chat', async () => {
    await send('A', 'B', 'Hello');
    await deliverRealtime('B');
    await deliverRealtime('A');
    expect((await conversation('A', 'B'))[0].status).toBe('delivered');

    await as('B', (app) => app.engine.markConversationRead(USERS.A.id));
    expect((await conversation('B', 'A'))[0].status).toBe('read');
    await deliverRealtime('A');
    expect((await conversation('A', 'B'))[0].status).toBe('read');
  });

  it('B replies and A receives it (both directions, ratchet continues)', async () => {
    await send('A', 'B', 'Hello');
    await deliverRealtime('B');
    await send('B', 'A', 'Hi A!');
    await deliverRealtime('A');

    const bodies = (await conversation('A', 'B')).map((m) => [m.direction, m.body]);
    expect(bodies).toEqual([
      ['in', 'Hi A!'],
      ['out', 'Hello'],
    ]);
  });

  it('ignores duplicate Pusher events', async () => {
    await send('A', 'B', 'once');
    const event = server.realtimeQueue.find((e) => e.device === 'B');
    server.realtimeQueue.push(event, event);

    await deliverRealtime('B');

    expect((await conversation('B', 'A')).map((m) => m.body)).toEqual(['once']);
  });

  it('fetches id-only (large envelope) events over HTTPS', async () => {
    const large = 'L'.repeat(LIMITS.PUSHER_INLINE_PAYLOAD_BYTES);
    await send('A', 'B', large);
    expect(server.realtimeQueue.find((e) => e.device === 'B').data.inline).toBe(false);

    await deliverRealtime('B');
    expect((await conversation('B', 'A'))[0].body).toBe(large);
  });
});

describe('offline and reconnect', () => {
  it('B offline: messages wait on the server and arrive in order when B comes back', async () => {
    await as('B', (app) => app.engine.stopMessaging()); // B's app is closed
    server.realtimeQueue = [];
    for (const text of ['one', 'two', 'three']) await send('A', 'B', text);
    server.realtimeQueue = server.realtimeQueue.filter((e) => e.device !== 'B'); // never delivered

    await as('B', (app) => app.engine.startMessaging(USERS.B.id));

    expect((await conversation('B', 'A')).map((m) => m.body)).toEqual(['three', 'two', 'one']);
    expect(server.envelopes.every((e) => e.delivered)).toBe(true);
  });

  it('a dropped Pusher connection misses events; reconnect syncs them', async () => {
    storage.B.pusher.drop();
    await send('A', 'B', 'sent while B was disconnected');
    await deliverRealtime('B'); // lost: not connected
    expect(await conversation('B', 'A')).toEqual([]);

    await as('B', () => storage.B.pusher.reconnect());

    expect((await conversation('B', 'A'))[0].body).toBe('sent while B was disconnected');
  });

  it('drops Pusher in the background (so the server pushes) and catches up in the foreground', async () => {
    await as('B', (app) => app.engine.handleAppStateChange('background'));
    expect(storage.B.pusher.disconnected).toBe(true);
    expect(apps.B.engine.useMessagingStore.getState().realtime).toBe('paused');

    await send('A', 'B', 'while B was in the background');
    await deliverRealtime('B'); // not connected: realtime event missed, no ack sent
    expect(server.envelopes.at(-1).delivered).toBe(false);

    await as('B', (app) => app.engine.handleAppStateChange('active'));

    expect((await conversation('B', 'A'))[0].body).toBe('while B was in the background');
    expect(server.envelopes.at(-1).delivered).toBe(true);
    expect(storage.B.pusher.disconnected).toBeFalsy(); // a new, connected client
  });

  it('sending while offline queues the message and sends it once back online', async () => {
    storage.A.offline = true;
    await send('A', 'B', 'queued');
    const [queued] = await conversation('A', 'B');
    expect(queued).toMatchObject({ status: 'failed', error: 'TEMPORARY' });

    storage.A.offline = false;
    await as('A', (app) => app.engine.requestSync());

    expect((await conversation('A', 'B'))[0].status).toBe('sent');
    await deliverRealtime('B');
    expect((await conversation('B', 'A')).map((m) => m.body)).toEqual(['queued']);
  });

  it('a retry resends the same ciphertext and clientMessageId (no duplicates)', async () => {
    server.failNextPost = 1; // server error after the client sent the request
    await send('A', 'B', 'retry me');
    const [failed] = await conversation('A', 'B');
    expect(failed.status).toBe('failed');

    await as('A', (app) => app.engine.retryFailedMessage(USERS.A.id, failed.clientMessageId));
    await as('A', (app) => app.engine.retryFailedMessage(USERS.A.id, failed.clientMessageId));

    const posts = server.requests.filter((r) => r.method === 'POST' && r.path === '/messages');
    expect(posts).toHaveLength(2); // the failed one + one successful retry
    expect(posts[0].body).toBe(posts[1].body); // byte-identical ciphertext and id
    expect(server.messages).toHaveLength(1);
    await deliverRealtime('B');
    expect((await conversation('B', 'A')).map((m) => m.body)).toEqual(['retry me']);
  });
});

describe('force-close and restart', () => {
  it('received messages survive a force-close of B', async () => {
    await send('A', 'B', 'keep me');
    await deliverRealtime('B');

    apps.B.engine.stopMessaging();
    boot('B');
    await as('B', async (app) => {
      await app.auth.useAuthStore.getState().initialize();
      await app.engine.startMessaging(USERS.B.id);
    });

    expect((await conversation('B', 'A')).map((m) => m.body)).toEqual(['keep me']);
  });

  it('a message whose send was interrupted by a crash is sent after restart, exactly once', async () => {
    // A stores and encrypts the message, then the app is killed before the POST completes.
    await as('A', async (app) => {
      const id = await app.signal.enqueueText(USERS.B.id, 'interrupted');
      storage.A.offline = true;
      await app.signal.deliverOutgoing(USERS.A.id, id).catch(() => {});
      storage.A.offline = false;
    });
    apps.A.engine.stopMessaging();
    boot('A');
    await as('A', async (app) => {
      await app.auth.useAuthStore.getState().initialize();
      await app.engine.startMessaging(USERS.A.id);
    });

    expect((await conversation('A', 'B'))[0]).toMatchObject({
      body: 'interrupted',
      status: 'sent',
    });
    await deliverRealtime('B');
    expect((await conversation('B', 'A')).map((m) => m.body)).toEqual(['interrupted']);
    expect(server.messages).toHaveLength(1);
  });

  it('receipts missed while A was closed are recovered from the server', async () => {
    await send('A', 'B', 'did you read it?');
    apps.A.engine.stopMessaging();
    await deliverRealtime('B');
    await as('B', (app) => app.engine.markConversationRead(USERS.A.id));
    server.realtimeQueue = server.realtimeQueue.filter((e) => e.device !== 'A'); // A missed them

    await as('A', (app) => app.engine.startMessaging(USERS.A.id));
    expect((await conversation('A', 'B'))[0].status).toBe('read');
  });
});

describe('failures', () => {
  it('shows an undecryptable placeholder for a corrupted envelope and keeps going', async () => {
    await send('A', 'B', 'first');
    await send('A', 'B', 'second');
    const [first] = server.envelopes;
    // Tamper with the first ciphertext (as a broken relay would).
    const bytes = Buffer.from(first.ciphertext, 'base64');
    bytes[bytes.length - 5] ^= 0xff;
    first.ciphertext = bytes.toString('base64');
    server.realtimeQueue = [];

    await as('B', (app) => app.engine.requestSync());

    const inbox = await conversation('B', 'A');
    expect(inbox.map((m) => m.status)).toEqual(['received', 'undecryptable']);
    expect(inbox[1].body).toBe('');
    expect(server.envelopes.every((e) => e.delivered)).toBe(true); // nothing left to block sync
  });

  it('logout disconnects Pusher and wipes messages, keys and the database', async () => {
    await send('A', 'B', 'bye');
    await as('A', (app) => app.auth.useAuthStore.getState().logout());

    expect(storage.A.pusher.disconnected).toBe(true);
    expect(storage.A.sqliteFiles.has('securechat.db')).toBe(false);
    expect([...storage.A.secureStore.keys()]).toEqual(['device.id']);
    expect(apps.A.engine.useMessagingStore.getState().realtime).toBe('idle');
  });
});

describe('security code changes (peer identity key changed)', () => {
  const identityKeyOf = (name) =>
    JSON.parse(storage[name].secureStore.get('signal.identity')).identityKey;
  const trustedKey = (name, peer) =>
    as(name, (app) => app.store.loadPeerIdentity(app.store.addressOf(USERS[peer].id)));
  const pendingChange = (name, peer) =>
    as(name, (app) => app.signal.getPendingIdentityChange(USERS[peer].id));
  const envelopesFrom = (name, peer) =>
    as(name, (app) =>
      app.db
        .getDatabase()
        .getAllAsync(
          'SELECT status, ciphertext FROM message_envelopes WHERE sender_user_id = ? ORDER BY seq;',
          USERS[peer].id,
        ),
    );
  const accept = (name, peer, key) =>
    as(name, (app) => app.engine.acceptSecurityCode(USERS[name].id, USERS[peer].id, key));

  /** Logout + login on the same install (same device id): new identity key, as on a phone. */
  async function signInAgain(name) {
    await as(name, (app) => app.auth.useAuthStore.getState().logout());
    boot(name);
    await signInAndStart(name);
  }

  /** A and B talk, then B signs in again and sends A a message with the new identity key. */
  async function bChangesKeyAndWrites(text = 'I have a new phone') {
    await send('A', 'B', 'Hello');
    await deliverRealtime('B');
    await send('B', 'A', 'Hi A!');
    await deliverRealtime('A');
    const oldKey = identityKeyOf('B');
    await signInAgain('B');
    expect(identityKeyOf('B')).not.toBe(oldKey);
    await send('B', 'A', text);
    await deliverRealtime('A');
    return { oldKey, newKey: identityKeyOf('B') };
  }

  it('first contact: the peer identity is stored, no warning, messages decrypt', async () => {
    await send('A', 'B', 'Hello');
    await deliverRealtime('B');

    expect(await trustedKey('B', 'A')).toBe(identityKeyOf('A'));
    expect(await trustedKey('A', 'B')).toBe(identityKeyOf('B'));
    expect(await pendingChange('B', 'A')).toBeNull();
    expect((await conversation('B', 'A'))[0]).toMatchObject({ body: 'Hello', status: 'received' });
  });

  it('unchanged identity (even after a force-close): no warning, normal decryption', async () => {
    await send('A', 'B', 'one');
    await deliverRealtime('B');
    apps.B.engine.stopMessaging();
    boot('B');
    await as('B', async (app) => {
      await app.auth.useAuthStore.getState().initialize();
      await app.engine.startMessaging(USERS.B.id);
    });
    await send('A', 'B', 'two');
    await deliverRealtime('B');

    expect((await conversation('B', 'A')).map((m) => m.body)).toEqual(['two', 'one']);
    expect(await pendingChange('B', 'A')).toBeNull();
    expect(await as('B', (app) => app.signal.listIdentityChanges(USERS.A.id))).toEqual([]);
  });

  it('changed identity: A holds the message, keeps trusting the old key, sends no receipt', async () => {
    const { oldKey, newKey } = await bChangesKeyAndWrites('I have a new phone');

    const change = await pendingChange('A', 'B');
    expect(change).toMatchObject({ newIdentityKey: newKey, previousIdentityKey: oldKey });
    expect(await trustedKey('A', 'B')).toBe(oldKey); // NOT replaced

    // Placeholder only: no plaintext was produced, the ciphertext is kept locally.
    const [held] = await conversation('A', 'B');
    expect(held).toMatchObject({ direction: 'in', status: 'identity_pending', body: '' });
    expect((await conversation('A', 'B')).some((m) => m.body === 'I have a new phone')).toBe(false);
    const envelopes = await envelopesFrom('A', 'B');
    expect(envelopes.at(-1).status).toBe('identity_pending');
    expect(envelopes.at(-1).ciphertext.length).toBeGreaterThan(0);

    // Opening the chat neither marks it read nor sends a read receipt; it is not unread either.
    // (The earlier, normally decrypted "Hi A!" does get its receipt.)
    const heldId = server.messages.at(-1).id;
    await as('A', (app) => app.engine.markConversationRead(USERS.B.id));
    const receipts = server.requests.filter((r) => r.path === '/messages/read');
    expect(receipts.some((r) => r.body.includes(heldId))).toBe(false);
    expect(server.messages.at(-1).readAt).toBeNull();
    const [row] = await as('A', (app) => app.messages.listConversations());
    expect(row).toMatchObject({ lastStatus: 'identity_pending', unread: 0 });

    // A's replies are held too: nothing is encrypted for either key until A decides.
    const before = server.messages.length;
    await send('A', 'B', 'is that really you?');
    expect((await conversation('A', 'B'))[0]).toMatchObject({
      status: 'failed',
      error: 'UNTRUSTED_IDENTITY',
    });
    expect(server.messages.length).toBe(before);
  });

  it('explicit trust: held messages decrypt in place, the session is rebuilt, held replies are sent', async () => {
    const { newKey } = await bChangesKeyAndWrites('I have a new phone');
    const heldId = server.messages.at(-1).id;
    await send('A', 'B', 'is that really you?'); // held
    const placeholder = (await conversation('A', 'B')).find((m) => m.direction === 'in');

    // A key other than the one whose code the user saw is never accepted.
    expect(await accept('A', 'B', identityKeyOf('A'))).toBe(false);
    expect(await pendingChange('A', 'B')).not.toBeNull();

    expect(await accept('A', 'B', newKey)).toBe(true);
    expect(await accept('A', 'B', newKey)).toBe(false); // repeated tap: nothing more happens

    expect(await trustedKey('A', 'B')).toBe(newKey);
    expect(await pendingChange('A', 'B')).toBeNull();
    const chat = await conversation('A', 'B');
    const incoming = chat.filter((m) => m.direction === 'in' && m.id >= placeholder.id);
    expect(incoming).toHaveLength(1); // same row, no duplicate
    expect(incoming[0]).toMatchObject({
      id: placeholder.id,
      body: 'I have a new phone',
      status: 'received',
    });
    expect(chat[0]).toMatchObject({ body: 'is that really you?', status: 'sent' });
    expect((await envelopesFrom('A', 'B')).at(-1)).toEqual({ status: 'done', ciphertext: '' });

    // B decrypts the held reply, and both directions keep working on the new session.
    await deliverRealtime('B');
    expect((await conversation('B', 'A')).map((m) => m.body)).toEqual([
      'is that really you?',
      'I have a new phone',
    ]);
    await send('B', 'A', 'yes, new phone');
    await deliverRealtime('A');
    expect((await conversation('A', 'B'))[0]).toMatchObject({
      body: 'yes, new phone',
      status: 'received',
    });

    // Now (and only now) the formerly held message gets its read receipt.
    expect(
      server.requests.some((r) => r.path === '/messages/read' && r.body.includes(heldId)),
    ).toBe(false);
    await as('A', (app) => app.engine.markConversationRead(USERS.B.id));
    const receipts = server.requests.filter((r) => r.path === '/messages/read');
    expect(receipts.some((r) => r.body.includes(heldId))).toBe(true);
    const events = await as('A', (app) => app.signal.listIdentityChanges(USERS.B.id));
    expect(events).toEqual([expect.objectContaining({ status: 'accepted' })]);
  });

  it('A writes first after B signed in again: the old session is refused, the change detected, B gets nothing unreadable', async () => {
    await send('A', 'B', 'Hello');
    await deliverRealtime('B');
    await signInAgain('B');
    const messagesBefore = server.messages.length;

    await send('A', 'B', 'are you there?');

    const conflict = server.requests.filter((r) => r.method === 'POST' && r.path === '/messages');
    expect(JSON.parse(conflict.at(-1).body).recipientRegistrationId).toEqual(expect.any(Number));
    expect(server.messages.length).toBe(messagesBefore); // rejected as stale, nothing stored
    expect((await conversation('A', 'B'))[0]).toMatchObject({
      status: 'failed',
      error: 'UNTRUSTED_IDENTITY',
    });
    expect((await pendingChange('A', 'B')).newIdentityKey).toBe(identityKeyOf('B'));
    expect(await conversation('B', 'A')).toEqual([]);

    expect(await accept('A', 'B', identityKeyOf('B'))).toBe(true);
    await deliverRealtime('B');
    expect((await conversation('B', 'A')).map((m) => [m.body, m.status])).toEqual([
      ['are you there?', 'received'],
    ]);
  });

  it('not accepting: the old key stays trusted, later messages are held as ciphertext too', async () => {
    const { oldKey } = await bChangesKeyAndWrites('first');
    await send('B', 'A', 'second');
    await send('B', 'A', 'third');
    await deliverRealtime('A');

    expect(await trustedKey('A', 'B')).toBe(oldKey);
    const held = (await conversation('A', 'B')).filter((m) => m.status === 'identity_pending');
    expect(held).toHaveLength(3);
    expect(held.every((m) => m.body === '')).toBe(true);
    const envelopes = (await envelopesFrom('A', 'B')).filter(
      (e) => e.status === 'identity_pending',
    );
    expect(envelopes).toHaveLength(3);
    expect(envelopes.every((e) => e.ciphertext.length > 0)).toBe(true);
    // Later syncs leave them alone (not retried, not turned into "could not be decrypted").
    await as('A', (app) => app.engine.requestSync());
    expect(
      (await conversation('A', 'B')).filter((m) => m.status === 'identity_pending'),
    ).toHaveLength(3);
  });

  it('the pending change survives a force-close; accepting after the restart works', async () => {
    const { newKey } = await bChangesKeyAndWrites('before restart');
    apps.A.engine.stopMessaging();
    boot('A');
    await as('A', async (app) => {
      await app.auth.useAuthStore.getState().initialize();
      await app.engine.startMessaging(USERS.A.id);
    });

    expect((await pendingChange('A', 'B')).newIdentityKey).toBe(newKey);
    expect((await conversation('A', 'B'))[0].status).toBe('identity_pending');
    expect(await accept('A', 'B', newKey)).toBe(true);
    expect((await conversation('A', 'B'))[0]).toMatchObject({
      body: 'before restart',
      status: 'received',
    });
  });

  it('survives a Pusher disconnect and accepting offline; held replies go out once online', async () => {
    await send('A', 'B', 'Hello');
    await deliverRealtime('B');
    await signInAgain('B');
    const newKey = identityKeyOf('B');
    storage.A.pusher.drop();
    await send('B', 'A', 'sent while A was disconnected');
    await deliverRealtime('A'); // lost
    await as('A', () => storage.A.pusher.reconnect()); // catch-up sync

    expect((await conversation('A', 'B'))[0].status).toBe('identity_pending');
    await send('A', 'B', 'held reply');

    storage.A.offline = true;
    expect(await accept('A', 'B', newKey)).toBe(true);
    // Held incoming messages are decrypted locally (no network needed)...
    expect((await conversation('A', 'B')).find((m) => m.direction === 'in')).toMatchObject({
      body: 'sent while A was disconnected',
      status: 'received',
    });
    // ...held outgoing ones wait for the connection.
    expect((await conversation('A', 'B'))[0]).toMatchObject({
      status: 'failed',
      error: 'TEMPORARY',
    });

    storage.A.offline = false;
    await as('A', (app) => app.engine.requestSync());
    expect((await conversation('A', 'B'))[0].status).toBe('sent');
    await deliverRealtime('B');
    expect((await conversation('B', 'A'))[0].body).toBe('held reply');
  });

  it('duplicate Pusher events while pending: one held message, then one decrypted message', async () => {
    await send('A', 'B', 'Hello');
    await deliverRealtime('B');
    await signInAgain('B');
    await send('B', 'A', 'only once');
    const event = server.realtimeQueue.find((e) => e.device === 'A' && e.event === 'envelope');
    server.realtimeQueue.push(event, event);
    await deliverRealtime('A');

    const inbound = async () => (await conversation('A', 'B')).filter((m) => m.direction === 'in');
    expect(await inbound()).toHaveLength(1);
    await accept('A', 'B', identityKeyOf('B'));
    server.realtimeQueue.push(event);
    await deliverRealtime('A');
    expect((await inbound()).map((m) => [m.body, m.status])).toEqual([['only once', 'received']]);
  });

  it('security code: same 60 digits on both phones, changes with the key, never sent anywhere', async () => {
    await send('A', 'B', 'Hello');
    await deliverRealtime('B');
    const codeA = await as('A', (app) => app.signal.getSecurityCode(USERS.A.id, USERS.B.id));
    const codeB = await as('B', (app) => app.signal.getSecurityCode(USERS.B.id, USERS.A.id));
    expect(codeA.code).toMatch(/^\d{60}$/);
    expect(codeB.code).toBe(codeA.code);
    expect(codeA.pending).toBe(false);

    await signInAgain('B');
    await send('B', 'A', 'new key');
    await deliverRealtime('A');
    const pending = await as('A', (app) => app.signal.getSecurityCode(USERS.A.id, USERS.B.id));
    const newB = await as('B', (app) => app.signal.getSecurityCode(USERS.B.id, USERS.A.id));
    expect(pending.pending).toBe(true);
    expect(pending.code).not.toBe(codeA.code);
    expect(pending.code).toBe(newB.code); // what B sees for A after re-registering

    // Nothing about trust decisions or security codes reaches the server or Pusher.
    const wire = [
      server.requests.map((r) => `${r.path} ${r.body}`).join('\n'),
      JSON.stringify(server.published),
    ].join('\n');
    for (const code of [codeA.code, pending.code]) {
      expect(wire.includes(code)).toBe(false);
      expect(wire.includes(code.slice(0, 20))).toBe(false);
    }
    expect(wire).not.toMatch(/identity_pending|UNTRUSTED_IDENTITY|security/i);
    expect(server.published.every((e) => ['envelope', 'receipt'].includes(e.event))).toBe(true);
  });

  it('logout wipes the identity-change state with the rest of the local Signal state', async () => {
    await bChangesKeyAndWrites('held');
    await as('A', (app) => app.auth.useAuthStore.getState().logout());
    expect(storage.A.sqliteFiles.has('securechat.db')).toBe(false);
    expect(storage.A.secureStore.has('signal.identity')).toBe(false);

    boot('A');
    await signInAndStart('A');
    expect(await pendingChange('A', 'B')).toBeNull();
    expect(await conversation('A', 'B')).toEqual([]);
  });
});

describe('security', () => {
  it('no plaintext in any request, realtime event or response; no private keys sent', async () => {
    const texts = ['Hello', 'Secret plan 🔐'];
    await send('A', 'B', texts[0]);
    await deliverRealtime('B');
    await send('B', 'A', texts[1]);
    await deliverRealtime('A');
    await as('B', (app) => app.engine.markConversationRead(USERS.A.id));

    const wire = [
      server.requests.map((r) => r.body).join('\n'),
      JSON.stringify(server.published),
      JSON.stringify(server.envelopes),
    ].join('\n');
    for (const text of texts) {
      expect(wire.includes(text)).toBe(false);
      expect(wire.includes(Buffer.from(text).toString('base64'))).toBe(false);
    }

    const secrets = [];
    for (const name of ['A', 'B']) {
      secrets.push(JSON.parse(storage[name].secureStore.get('signal.identity')).identityKeyPair);
      secrets.push(storage[name].secureStore.get('db.key'));
    }
    for (const secret of secrets) expect(wire.includes(secret)).toBe(false);
  });

  it('the mobile app never contains the Pusher secret (only the public key, from the API)', () => {
    const root = path.join(__dirname, '..');
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(js|json)$/.test(entry)) files.push(full);
      }
    };
    walk(path.join(root, 'src'));
    files.push(path.join(root, 'app.json'), path.join(root, 'eas.json'));
    for (const name of ['.env', '.env.example']) {
      try {
        statSync(path.join(root, name));
        files.push(path.join(root, name));
      } catch {
        // Optional file.
      }
    }

    // No secret env variable, no secret passed to a Pusher client, no Pusher env config.
    const offending = files.filter((file) =>
      /PUSHER_SECRET|EXPO_PUBLIC_PUSHER|\bsecret\s*:/i.test(readFileSync(file, 'utf8')),
    );
    expect(offending).toEqual([]);
    expect(files.length).toBeGreaterThan(20);
    // The client is configured from the API (public key + cluster), never from the bundle.
    const realtime = readFileSync(path.join(root, 'src/messaging/realtime.js'), 'utf8');
    expect(realtime).toMatch(/apiRequest\('GET', '\/pusher\/config'\)/);
  });
});
