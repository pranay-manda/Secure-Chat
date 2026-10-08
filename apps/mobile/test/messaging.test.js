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
        if (Object.keys(body).sort().join() !== [...MESSAGE_FIELDS].sort().join()) {
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
    await as('A', (app) => app.engine.createConversation(USERS.B.id, '  Bob  '));

    const list = await as('A', (app) => app.messages.listConversations());
    expect(list).toEqual([
      expect.objectContaining({ peerUserId: USERS.B.id, title: 'Bob', lastBody: null, unread: 0 }),
    ]);
    // Local only: nothing about the conversation or nickname was sent to the server.
    expect(server.requests.map((r) => r.body).join()).not.toContain('Bob');
  });
});

describe('send and receive through Pusher', () => {
  it('A sends "Hello": stored locally, encrypted, posted as ciphertext only', async () => {
    await send('A', 'B', 'Hello');

    const post = server.requests.find((r) => r.method === 'POST' && r.path === '/messages');
    expect(post.body).not.toContain('Hello');
    expect(Object.keys(JSON.parse(post.body)).sort()).toEqual([...MESSAGE_FIELDS].sort());

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
