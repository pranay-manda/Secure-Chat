/* global jest */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { encryptedAttachmentSize, LIMITS, SIGNAL } from '@secure-chat/shared/constants';

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
      calls: require('../src/calls/callEngine'),
      connectivity: require('../src/lib/connectivity'),
      callHistory: require('../src/calls/callHistory'),
      media: require('../src/media/attachmentService'),
      mediaFiles: require('../src/media/mediaFiles'),
      systemUi: require('../src/lib/systemUi'),
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
    missedCalls: {}, // by device name: the server's missed-call notes
    attachments: [], // { id, uploader, recipient, clientAttachmentId, size, key, uploaded, received }
    blobs: new Map(), // storage key -> Buffer (encrypted blobs only)
    blobOffline: false, // storage unreachable
    failComplete: 0, // next N /complete calls answer 503
    blobRequests: [], // { method, url, body? }
    presence: {}, // by device name: time of the last heartbeat (deleted on "going away")
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
      'POST',
      /^\/keys\/one-time$/,
      ({ me, body }) => {
        const d = state.devices[USERS[me].id];
        d.oneTime.push(...body.preKeys);
        return { body: { status: { registered: true, oneTimePreKeyCount: d.oneTime.length } } };
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
    // Voice calls: no call in progress unless a test says so (recovery reads this).
    ['GET', /^\/calls\/current$/, () => ({ body: { call: null } })],
    ['POST', /^\/calls\/[\w-]+\/(reject|end)$/, () => ({ status: 204 })],
    ['GET', /^\/calls\/missed$/, ({ me }) => ({ body: { missed: state.missedCalls[me] ?? [] } })],
    // Online status: heartbeats and "going away", per user; queries answer from them.
    [
      'POST',
      /^\/presence\/heartbeat$/,
      ({ me }) => {
        state.presence[me] = Date.now();
        return { status: 204 };
      },
    ],
    [
      'DELETE',
      /^\/presence$/,
      ({ me }) => {
        delete state.presence[me];
        return { status: 204 };
      },
    ],
    [
      'GET',
      /^\/presence\?userIds=([^&]+)$/,
      ({ match }) => ({
        body: {
          presence: Object.fromEntries(
            match[1].split(',').map((id) => [id, state.presence[nameOf(id)] !== undefined]),
          ),
        },
      }),
    ],
    [
      'POST',
      /^\/calls\/missed\/ack$/,
      ({ me, body }) => {
        state.missedCalls[me] = (state.missedCalls[me] ?? []).filter(
          (note) => !body.callIds.includes(note.callId),
        );
        return { status: 204 };
      },
    ],
  ];

  // Attachments: the API contract (idempotent slots, exact sizes, uploader/recipient only) and a
  // blob store reached through "pre-signed" URLs, like the real local storage driver.
  const attachmentById = (id) => state.attachments.find((a) => a.id === id);
  handlers.push(
    [
      'POST',
      /^\/attachments$/,
      ({ me, body }) => {
        let a = state.attachments.find(
          (x) => x.uploader === me && x.clientAttachmentId === body.clientAttachmentId,
        );
        if (!a) {
          a = {
            id: `${'f'.repeat(18)}${String(state.attachments.length + 1).padStart(6, '0')}`,
            uploader: me,
            recipient: nameOf(body.recipientUserId),
            clientAttachmentId: body.clientAttachmentId,
            size: body.size,
            key: `blob${state.attachments.length + 1}`,
            uploaded: false,
            received: false,
          };
          state.attachments.push(a);
        }
        return {
          status: 201,
          body: {
            attachmentId: a.id,
            status: a.uploaded ? 'uploaded' : 'pending',
            size: a.size,
            ...(!a.uploaded && {
              upload: {
                url: `/blobs/${a.key}?exp=1&sig=put`,
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream' },
              },
            }),
          },
        };
      },
    ],
    [
      'POST',
      /^\/attachments\/(\w+)\/complete$/,
      ({ me, match }) => {
        const a = attachmentById(match[1]);
        if (!a || a.uploader !== me)
          return { status: 404, body: { error: { code: 'ATTACHMENT_NOT_FOUND' } } };
        if (state.failComplete > 0) {
          state.failComplete -= 1;
          return { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE' } } };
        }
        if (state.blobs.get(a.key)?.length !== a.size) {
          return { status: 409, body: { error: { code: 'ATTACHMENT_INCOMPLETE' } } };
        }
        a.uploaded = true;
        return { body: { attachmentId: a.id, status: 'uploaded', size: a.size } };
      },
    ],
    [
      'GET',
      /^\/attachments\/(\w+)$/,
      ({ me, match }) => {
        const a = attachmentById(match[1]);
        if (!a?.uploaded || a.expired || (a.recipient !== me && a.uploader !== me)) {
          return { status: 404, body: { error: { code: 'ATTACHMENT_NOT_FOUND' } } };
        }
        return {
          body: {
            attachmentId: a.id,
            size: a.size,
            download: { url: `/blobs/${a.key}?exp=1&sig=get`, method: 'GET', headers: {} },
          },
        };
      },
    ],
    [
      'POST',
      /^\/attachments\/(\w+)\/received$/,
      ({ me, match }) => {
        const a = attachmentById(match[1]);
        if (!a || a.recipient !== me)
          return { status: 404, body: { error: { code: 'ATTACHMENT_NOT_FOUND' } } };
        a.received = true;
        return { status: 204 };
      },
    ],
  );
  globalThis.__blobServer = async ({ method, url, body }) => {
    if (state.blobOffline || globalThis.__device.offline) throw new Error('Network request failed');
    state.blobRequests.push({ method, url, body });
    const key = /^http:\/\/api\.test\/blobs\/(\w+)\?/.exec(url)?.[1];
    if (!key) return { status: 404 };
    if (method === 'PUT') {
      const a = state.attachments.find((x) => x.key === key);
      if (!a || body.length !== a.size) return { status: 400 };
      state.blobs.set(key, Buffer.from(body));
      return { status: 200 };
    }
    const blob = state.blobs.get(key);
    return blob ? { status: 200, body: state.serveBlob?.(blob) ?? blob } : { status: 404 };
  };

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

/** The Signal native module the apps use (official libsignal; see mocks/signalNativeMock.js). */
const signalNative = () => require('../modules/signal-protocol').getSignalNative();

/**
 * Runs `fn` with `bytes` as the plaintext of the one message encrypted meanwhile, instead of
 * what this app version puts there: what another app version (older, newer or misbehaving)
 * would send. Real libsignal encrypts it; the receiving app is the current code.
 */
async function sendingPlaintext(bytes, fn) {
  const native = signalNative();
  const { encrypt } = native;
  let used = 0;
  native.encrypt = (local, remote) => {
    used += 1;
    return encrypt(local, remote, Buffer.from(bytes).toString('base64'));
  };
  try {
    await fn();
  } finally {
    native.encrypt = encrypt;
  }
  if (used !== 1) throw new Error(`expected one encrypted message, got ${used}`);
}

/** The plaintexts this app version hands to libsignal while `fn` runs. */
async function plaintextsOf(fn) {
  const native = signalNative();
  const { encrypt } = native;
  const seen = [];
  native.encrypt = (local, remote, plaintext) => {
    seen.push(Buffer.from(plaintext, 'base64'));
    return encrypt(local, remote, plaintext);
  };
  try {
    await fn();
  } finally {
    native.encrypt = encrypt;
  }
  return seen;
}

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

  it('our own photo picker or permission dialog does not count as leaving the app', async () => {
    const { AppState } = require('react-native');
    const realState = AppState.currentState;
    const presenceClears = () =>
      server.requests.filter((r) => r.method === 'DELETE' && r.path === '/presence').length;
    const before = presenceClears();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      let closePicker;
      const picking = apps.B.systemUi.withSystemUi(
        () =>
          new Promise((resolve) => {
            closePicker = resolve;
          }),
      );
      AppState.currentState = 'background';
      apps.B.engine.handleAppStateChange('background');
      expect(storage.B.pusher.disconnected).toBeFalsy(); // still connected
      expect(apps.B.engine.useMessagingStore.getState().realtime).not.toBe('paused');
      closePicker();
      await picking;
      AppState.currentState = 'active';
      apps.B.engine.handleAppStateChange('active');
      jest.advanceTimersByTime(apps.B.systemUi.SYSTEM_UI_MAX_MS);
      expect(storage.B.pusher.disconnected).toBeFalsy();
      expect(presenceClears()).toBe(before); // never shown offline to others

      // Gone to the home screen from the picker and still away when the grace ends: pause.
      apps.B.systemUi.withSystemUi(() => new Promise(() => {}));
      AppState.currentState = 'background';
      apps.B.engine.handleAppStateChange('background');
      expect(storage.B.pusher.disconnected).toBeFalsy();
      jest.advanceTimersByTime(apps.B.systemUi.SYSTEM_UI_MAX_MS);
      expect(storage.B.pusher.disconnected).toBe(true);
      expect(apps.B.engine.useMessagingStore.getState().realtime).toBe('paused');
    } finally {
      jest.useRealTimers();
      AppState.currentState = realState;
    }
    await settle('B');
    expect(presenceClears()).toBe(before + 1);
  });

  it('returning to the foreground also runs key maintenance (pre-key top-up and rotation)', async () => {
    const keyChecks = () =>
      server.requests.filter((r) => r.method === 'GET' && r.path === '/keys/status').length;
    const before = keyChecks();
    await as('B', (app) => app.engine.handleAppStateChange('background'));
    expect(keyChecks()).toBe(before);

    // B's one-time pre-keys were used up while the app sat open.
    server.devices[USERS.B.id].oneTime = [];
    await as('B', (app) => app.engine.handleAppStateChange('active'));

    expect(keyChecks()).toBe(before + 1);
    expect(server.devices[USERS.B.id].oneTime.length).toBeGreaterThan(0); // topped up
  });

  it('keeps Pusher connected in the background during a call, and drops it when the call ends', async () => {
    const { AppState } = require('react-native');
    const realState = AppState.currentState;
    const callId = '55555555-5555-4555-8555-555555555555';
    try {
      await as('B', async (app) => {
        app.calls.handleCallEvent({
          type: 'invite',
          callId,
          callerUserId: USERS.A.id,
          createdAt: new Date().toISOString(),
          ringExpiresAt: new Date(Date.now() + 45_000).toISOString(),
        });
      });
      expect(apps.B.calls.useCallStore.getState().phase).toBe('incoming');

      AppState.currentState = 'background';
      await as('B', (app) => app.engine.handleAppStateChange('background'));
      expect(storage.B.pusher.disconnected).toBeFalsy(); // call signaling keeps arriving

      await as('B', (app) => app.calls.declineCall());
      expect(storage.B.pusher.disconnected).toBe(true); // back to normal background behavior
    } finally {
      AppState.currentState = realState;
    }
  });

  it('a call missed while the app was away reaches the call history when it comes back', async () => {
    const callId = '66666666-6666-4666-8666-666666666666';
    await as('B', (app) => app.engine.handleAppStateChange('background'));
    server.missedCalls.B = [
      {
        callId,
        callerUserId: USERS.A.id,
        createdAt: '2026-10-09T10:00:00.000Z',
        endedAt: '2026-10-09T10:00:45.000Z',
      },
    ];

    await as('B', (app) => app.engine.handleAppStateChange('active'));

    const rows = await as('B', (app) => app.callHistory.listCallLog());
    expect(rows).toEqual([
      expect.objectContaining({
        callId,
        peerUserId: USERS.A.id,
        direction: 'in',
        outcome: 'missed',
      }),
    ]);
    expect(server.missedCalls.B).toEqual([]); // acknowledged: the server forgot it
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

describe('message content format (R1: versioned, typed; raw text from older versions)', () => {
  const content = () => require('../src/messaging/content');
  const utf8 = (text) => Buffer.from(text, 'utf8');
  /** Typed content as any app version could send it: the marker, then arbitrary JSON. */
  const typed = (json) =>
    Buffer.concat([
      Buffer.from([0xff]),
      utf8(typeof json === 'string' ? json : JSON.stringify(json)),
    ]);
  const encoded = (value) => Buffer.from(content().encodeContent(value));
  /** A sends B a message whose Signal plaintext is `bytes`. */
  const sendRaw = (bytes) => sendingPlaintext(bytes, () => send('A', 'B', 'typed on this app'));
  const callAttestation = (fields = {}) => ({
    type: 'call.dtls',
    version: 1,
    callId: '11111111-1111-4111-8111-111111111111',
    role: 'caller',
    from: USERS.A.id,
    to: USERS.B.id,
    kind: 'voice',
    fingerprints: [`sha-256 ${Array(32).fill('AB').join(':')}`],
    ...fields,
  });
  const inbox = async () => (await conversation('B', 'A')).map((m) => [m.status, m.error, m.body]);
  const chatsOf = (name) => as(name, (app) => app.messages.listConversations());

  it('new text travels as versioned content inside the Signal message and arrives as text', async () => {
    const [plaintext] = await plaintextsOf(() => send('A', 'B', 'Hello 👋'));
    expect(plaintext[0]).toBe(0xff);
    expect(JSON.parse(plaintext.subarray(1).toString('utf8'))).toEqual({
      type: 'text',
      version: 1,
      text: 'Hello 👋',
    });

    await deliverRealtime('B');
    expect(await inbox()).toEqual([['received', null, 'Hello 👋']]);
  });

  it('raw text from an app version before R1 still decrypts, shows as text and gets receipts', async () => {
    await sendRaw(utf8('Sent by the old app ✓'));
    await deliverRealtime('B');
    expect(await inbox()).toEqual([['received', null, 'Sent by the old app ✓']]);
    expect((await chatsOf('B'))[0]).toMatchObject({ lastBody: 'Sent by the old app ✓', unread: 1 });

    await deliverRealtime('A');
    expect((await conversation('A', 'B'))[0].status).toBe('delivered');
    await as('B', (app) => app.engine.markConversationRead(USERS.A.id));
    await deliverRealtime('A');
    expect((await conversation('A', 'B'))[0].status).toBe('read');

    // The session carries on in both directions.
    await send('B', 'A', 'Hi back');
    await deliverRealtime('A');
    expect((await conversation('A', 'B'))[0]).toMatchObject({ direction: 'in', body: 'Hi back' });
  });

  it('old raw text that looks like typed or internal content is still just text', async () => {
    const lookalike = JSON.stringify(callAttestation());
    await sendRaw(utf8(lookalike));
    await deliverRealtime('B');
    expect(await inbox()).toEqual([['received', null, lookalike]]);
  });

  it('unknown types and versions arrive as a placeholder; later messages still decrypt', async () => {
    await sendRaw(typed({ type: 'poll', version: 1, question: 'Lunch?' }));
    await sendRaw(typed({ type: 'text', version: 2, text: 'from a later version' }));
    await send('A', 'B', 'still here');
    await deliverRealtime('B');

    expect(await inbox()).toEqual([
      ['received', null, 'still here'],
      ['unsupported', 'UNSUPPORTED_CONTENT', ''],
      ['unsupported', 'UNSUPPORTED_CONTENT', ''],
    ]);
    expect((await chatsOf('B'))[0]).toMatchObject({ lastBody: 'still here', unread: 1 });
  });

  it('malformed content arrives as a placeholder, never crashes, and the chat keeps working', async () => {
    const oversized = typed({
      type: 'text',
      version: 1,
      text: 'a'.repeat(content().CONTENT_LIMITS.MAX_BYTES),
    });
    for (const bytes of [
      typed('{"type":"text",'),
      typed({ type: 'text', version: 1 }),
      typed({ type: 'text', version: 1, text: 42 }),
      typed({ type: 'text', version: 1, text: 'hi', html: '<b>hi</b>' }),
      Buffer.from([0xff, 0xc3, 0x28]), // not UTF-8
      oversized,
    ]) {
      await sendRaw(bytes);
    }
    // The oversized one is a message a sender really could get through the API.
    const largest = Math.max(
      ...server.envelopes.map((e) => Buffer.from(e.ciphertext, 'base64').length),
    );
    expect(largest).toBeGreaterThan(content().CONTENT_LIMITS.MAX_BYTES);
    expect(largest).toBeLessThanOrEqual(SIGNAL.MAX_CIPHERTEXT_BYTES);

    await send('A', 'B', 'after');
    await deliverRealtime('B');
    expect(await inbox()).toEqual([
      ['received', null, 'after'],
      ...Array(6).fill(['unsupported', 'INVALID_CONTENT', '']),
    ]);
  });

  it('an attachment of a type this app cannot show (e.g. a PDF) is a placeholder; nothing of it is kept', async () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    await sendRaw(
      encoded({
        type: 'attachment',
        version: 1,
        id: 'AbCdEfGhIjKlMnOp',
        key,
        digest: Buffer.alloc(32, 9).toString('base64'),
        size: 1234,
        contentType: 'application/pdf',
        fileName: 'contract.pdf',
        caption: 'Goa, day 2',
      }),
    );
    await deliverRealtime('B');

    expect(await inbox()).toEqual([['unsupported', 'UNSUPPORTED_CONTENT', '']]);
    const kept = JSON.stringify(
      await as('B', async (app) => {
        const db = app.db.getDatabase();
        return [
          await db.getAllAsync('SELECT * FROM messages;'),
          await db.getAllAsync('SELECT * FROM message_envelopes;'),
          await db.getAllAsync('SELECT * FROM attachments;'),
        ];
      }),
    );
    for (const secret of [key, 'contract.pdf', 'Goa, day 2']) expect(kept).not.toContain(secret);
  });

  it('internal call-security content never becomes a message, a chat, an unread count or a receipt', async () => {
    await sendRaw(encoded(callAttestation())); // valid
    await sendRaw(typed({ ...callAttestation(), version: 9 })); // from a later version
    await sendRaw(typed(callAttestation({ fingerprints: ['sha-1 AB'] }))); // malformed
    await deliverRealtime('B');

    expect(await inbox()).toEqual([]);
    expect(await chatsOf('B')).toEqual([]);
    // Each was processed and acknowledged like any envelope (never retried or stuck)...
    expect(server.envelopes.map((e) => e.delivered)).toEqual([true, true, true]);
    const envelopes = await as('B', (app) =>
      app.db
        .getDatabase()
        .getAllAsync('SELECT status, error, ciphertext FROM message_envelopes ORDER BY seq;'),
    );
    expect(envelopes).toEqual(
      Array(3).fill({ status: 'done', error: 'INTERNAL_CONTENT', ciphertext: '' }),
    );
    // ...and nothing reads as a message: no read receipt can be sent for them.
    await as('B', (app) => app.engine.markConversationRead(USERS.A.id));
    expect(server.requests.some((r) => r.path === '/messages/read')).toBe(false);

    // The Signal session moved on with them: the next message decrypts normally.
    await send('A', 'B', 'after');
    await deliverRealtime('B');
    expect(await inbox()).toEqual([['received', null, 'after']]);
  });

  it('a message an older version encrypted and left in the outbox is sent unchanged after the update', async () => {
    await send('A', 'B', 'first'); // a session exists, so the next message encrypts offline
    storage.A.offline = true;
    await sendRaw(utf8('queued before the update'));
    expect((await conversation('A', 'B'))[0]).toMatchObject({
      status: 'failed',
      error: 'TEMPORARY',
    });

    storage.A.offline = false;
    await as('A', (app) => app.engine.requestSync()); // the updated app retries the stored ciphertext
    expect((await conversation('A', 'B'))[0].status).toBe('sent');
    await deliverRealtime('B');
    expect(await inbox()).toEqual([
      ['received', null, 'queued before the update'],
      ['received', null, 'first'],
    ]);
  });

  it('text that could never be sent is refused before anything is stored or sent', async () => {
    const tooLong = 'x'.repeat(content().CONTENT_LIMITS.TEXT_MAX_LENGTH + 1);
    for (const text of [tooLong, '']) {
      await expect(
        as('A', (app) => app.signal.enqueueText(USERS.B.id, text)),
      ).rejects.toMatchObject({ code: 'CONTENT_INVALID' });
    }
    expect(await conversation('A', 'B')).toEqual([]);
    expect(server.requests.some((r) => r.path === '/messages')).toBe(false);
  });
});

describe('photos, videos and voice notes (encrypted attachments)', () => {
  const MARKER = Buffer.from('PHOTO-PLAINTEXT-MARKER');
  const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(7000, MARKER)]);
  const fromUri = (uri) => decodeURI(uri.replace(/^file:\/\//, ''));
  const rootOf = (name) => storage[name].fsRoot;

  /** A file the picker/recorder put in the app cache (like expo-image-picker / expo-audio). */
  function intake(name, bytes = PHOTO, file = 'IMG_0001.jpg', dir = 'ImagePicker') {
    globalThis.__device = storage[name];
    const fs = require('./mocks/fileSystemMock');
    const folder = path.join(fs.Paths.cache.path, dir);
    mkdirSync(folder, { recursive: true });
    const full = path.join(folder, file);
    writeFileSync(full, bytes);
    return `file://${full.replace(/\\/g, '/')}`;
  }

  /** Every file on a device, relative to its private root, with its bytes. */
  function deviceFiles(name) {
    const out = [];
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else {
          out.push({
            rel: path.relative(rootOf(name), full).replace(/\\/g, '/'),
            bytes: readFileSync(full),
          });
        }
      }
    };
    walk(rootOf(name));
    return out;
  }
  const plaintextOnDisk = (name, marker = MARKER) =>
    deviceFiles(name)
      .filter((f) => f.bytes.includes(marker))
      .map((f) => f.rel);

  const sendMedia = (from, to, media, caption) =>
    as(from, (app) => app.engine.sendAttachment(USERS[from].id, USERS[to].id, media, caption));
  const photo = (name) => ({
    uri: intake(name),
    contentType: 'image/jpeg',
    width: 800,
    height: 600,
  });
  const latest = async (name, peer) => (await conversation(name, peer))[0];

  it('a photo is encrypted on the phone, stored as an opaque blob, and opened by the recipient', async () => {
    const media = photo('A');
    const [plaintext] = await plaintextsOf(() => sendMedia('A', 'B', media, 'Goa, day 2'));

    // The Signal message carries what the recipient needs: id, key, digest, real size.
    const content = JSON.parse(plaintext.subarray(1).toString('utf8'));
    expect(content).toMatchObject({
      type: 'attachment',
      version: 1,
      id: server.attachments[0].id,
      size: PHOTO.length,
      contentType: 'image/jpeg',
      width: 800,
      height: 600,
      caption: 'Goa, day 2',
    });
    expect(Buffer.from(content.key, 'base64')).toHaveLength(32);
    expect(Buffer.from(content.digest, 'base64')).toHaveLength(32);
    expect(content.fileName).toBeUndefined(); // the file name never leaves the phone

    // The server got one padded, encrypted blob and nothing that reveals the content.
    expect(server.attachments).toHaveLength(1);
    const blob = server.blobs.get(server.attachments[0].key);
    expect(blob.length).toBe(encryptedAttachmentSize(PHOTO.length));
    expect(blob.includes(MARKER)).toBe(false);
    const toServer = JSON.stringify(server.requests);
    for (const secret of [content.key, content.digest, 'Goa, day 2', 'image/jpeg', 'IMG_0001']) {
      expect(toServer).not.toContain(secret);
    }
    // Pusher carried only the Signal envelope (no attachment bytes).
    expect(JSON.stringify(server.published)).not.toContain(
      blob.subarray(12, 60).toString('base64'),
    );

    // Sender: the picker's plaintext copy is gone; only the encrypted copy is kept.
    expect(existsSync(fromUri(media.uri))).toBe(false);
    expect(plaintextOnDisk('A')).toEqual([]);
    expect((await latest('A', 'B')).attachment).toMatchObject({ kind: 'image', state: 'uploaded' });

    // Recipient: downloaded, verified and kept encrypted; the server is told it can drop it.
    await deliverRealtime('B');
    const received = await latest('B', 'A');
    expect(received).toMatchObject({
      body: 'Goa, day 2',
      status: 'received',
      attachment: { kind: 'image', state: 'downloaded', size: PHOTO.length, width: 800 },
    });
    expect(server.attachments[0].received).toBe(true);
    expect(plaintextOnDisk('B')).toEqual([]);

    // Viewing decrypts into a private temporary file, removed again on release.
    const opened = await as('B', (app) => app.media.openAttachment(received.id));
    expect(opened.uri).toContain('/cache/secure-media/');
    expect(readFileSync(fromUri(opened.uri)).equals(PHOTO)).toBe(true);
    opened.release();
    expect(plaintextOnDisk('B')).toEqual([]);

    const [chat] = await as('B', (app) => app.messages.listConversations());
    expect(chat).toMatchObject({ lastAttachmentKind: 'image', lastBody: 'Goa, day 2' });
  });

  it('media only ever lives in app-private storage (files/attachments, cache)', async () => {
    await sendMedia('A', 'B', photo('A'));
    await deliverRealtime('B');
    for (const name of ['A', 'B']) {
      const files = deviceFiles(name).map((f) => f.rel);
      expect(files.length).toBeGreaterThan(0);
      for (const rel of files) expect(rel).toMatch(/^(files|cache)\//);
      expect(files.filter((rel) => rel.startsWith('files/attachments/'))).toHaveLength(1);
      // Nothing that a media scanner or gallery would index: no public folders, no media names.
      expect(files.join()).not.toMatch(/DCIM|Pictures|Movies|Music|Download|\.jpe?g|\.mp4|\.m4a/i);
    }
    await as('A', (app) => {
      const { attachments, plaintext } = app.mediaFiles.MEDIA_LOCATIONS;
      expect(attachments()).toContain(`${rootOf('A').replace(/\\/g, '/')}/files/`);
      expect(plaintext()).toContain(`${rootOf('A').replace(/\\/g, '/')}/cache/`);
    });
  });

  it('a file outside the app (shared storage) is refused by the encryptor and left untouched', async () => {
    const outside = path.join(rootOf('A'), '..', `public-DCIM-${Date.now()}.jpg`);
    writeFileSync(outside, PHOTO);
    try {
      const media = { uri: `file://${outside.replace(/\\/g, '/')}`, contentType: 'image/jpeg' };
      await expect(sendMedia('A', 'B', media)).rejects.toMatchObject({ code: 'FAILED' });
      expect(existsSync(outside)).toBe(true); // never deleted: not the app's own copy
      expect(server.attachments).toHaveLength(0);
      expect(await conversation('A', 'B')).toEqual([]);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('JPEG location data is stripped before encryption (other types are left as they are)', async () => {
    await sendMedia('A', 'B', photo('A'));
    await sendMedia('A', 'B', { uri: intake('A', PHOTO, 'x.png'), contentType: 'image/png' });
    expect(storage.A.mediaCryptoCalls.filter((c) => c.fn === 'encryptFile')).toEqual([
      { fn: 'encryptFile', stripLocation: true },
      { fn: 'encryptFile', stripLocation: false },
    ]);
  });

  it('an interrupted upload is retried with the same attachment: no duplicates', async () => {
    server.blobOffline = true;
    await sendMedia('A', 'B', photo('A'));
    expect(await latest('A', 'B')).toMatchObject({ status: 'failed', error: 'TEMPORARY' });
    expect(server.attachments).toHaveLength(1);
    expect(server.messages).toHaveLength(0); // nothing is announced before the blob is stored

    server.blobOffline = false;
    server.failComplete = 1; // the bytes arrive, but completing fails once
    await as('A', (app) => app.engine.requestSync());
    expect(await latest('A', 'B')).toMatchObject({ status: 'failed', error: 'TEMPORARY' });

    await as('A', (app) => app.engine.requestSync());
    expect(await latest('A', 'B')).toMatchObject({ status: 'sent' });
    expect(server.attachments).toHaveLength(1);
    expect(server.messages).toHaveLength(1);
    await deliverRealtime('B');
    const inbox = await conversation('B', 'A');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].attachment.state).toBe('downloaded');
  });

  it('nothing is uploaded while the contact’s new security code is undecided', async () => {
    await as('A', (app) =>
      app.store.recordIdentityChange(USERS.B.id, `${USERS.B.id}.1`, 'old-key', 'new-key'),
    );
    await sendMedia('A', 'B', photo('A'));
    expect(await latest('A', 'B')).toMatchObject({ status: 'failed', error: 'UNTRUSTED_IDENTITY' });
    expect(server.attachments).toHaveLength(0);
    expect(server.blobRequests).toHaveLength(0);
  });

  it('a download that fails offline is retried by the next sync', async () => {
    await sendMedia('A', 'B', photo('A'));
    server.blobOffline = true;
    await deliverRealtime('B');
    expect((await latest('B', 'A')).attachment).toMatchObject({
      state: 'pending',
      error: 'TEMPORARY',
    });
    expect(deviceFiles('B').filter((f) => f.rel.includes('attachments/'))).toEqual([]);

    server.blobOffline = false;
    await as('B', (app) => app.engine.requestSync());
    expect((await latest('B', 'A')).attachment).toMatchObject({ state: 'downloaded', error: null });
  });

  it('a tampered blob is rejected (digest/tag), nothing is kept, and a retry can recover', async () => {
    await sendMedia('A', 'B', photo('A'));
    server.serveBlob = (blob) => {
      const bad = Buffer.from(blob);
      bad[100] ^= 0x01;
      return bad;
    };
    await deliverRealtime('B');
    const message = await latest('B', 'A');
    expect(message.attachment).toMatchObject({ state: 'failed', error: 'CORRUPT' });
    expect(deviceFiles('B').filter((f) => f.rel.includes('attachments/'))).toEqual([]);
    expect(server.attachments[0].received).toBe(false);

    server.serveBlob = null;
    await as('B', (app) => app.media.retryDownload(message.id));
    expect((await latest('B', 'A')).attachment.state).toBe('downloaded');
  });

  it('a download larger than expected is aborted and discarded', async () => {
    await sendMedia('A', 'B', photo('A'));
    server.serveBlob = (blob) => Buffer.concat([blob, Buffer.alloc(4096)]);
    await deliverRealtime('B');
    expect((await latest('B', 'A')).attachment).toMatchObject({
      state: 'failed',
      error: 'CORRUPT',
    });
    expect(deviceFiles('B').filter((f) => f.rel.includes('attachments/'))).toEqual([]);
  });

  it('an attachment gone from the server is shown as expired and not fetched again', async () => {
    await sendMedia('A', 'B', photo('A'));
    server.attachments[0].expired = true;
    await deliverRealtime('B');
    expect((await latest('B', 'A')).attachment).toMatchObject({
      state: 'failed',
      error: 'EXPIRED',
    });
    const gets = () => server.requests.filter((r) => r.path.startsWith('/attachments/')).length;
    const before = gets();
    await as('B', (app) => app.engine.requestSync());
    expect(gets()).toBe(before);
  });

  it('a wrong media key never yields plaintext (no partial file is left)', async () => {
    await sendMedia('A', 'B', photo('A'));
    await deliverRealtime('B');
    const message = await latest('B', 'A');
    await as('B', (app) =>
      app.db
        .getDatabase()
        .runAsync('UPDATE attachments SET media_key = ?;', Buffer.alloc(32, 1).toString('base64')),
    );
    await expect(as('B', (app) => app.media.openAttachment(message.id))).rejects.toMatchObject({
      code: 'CORRUPT',
    });
    expect(plaintextOnDisk('B')).toEqual([]);
    expect(deviceFiles('B').filter((f) => f.rel.startsWith('cache/secure-media/'))).toEqual([]);
  });

  it('a voice note is recorded into the cache, sent encrypted and arrives as a voice message', async () => {
    const VOICE = Buffer.from('VOICE-PLAINTEXT-MARKER'.repeat(500));
    const uri = intake('A', VOICE, 'recording-1.m4a', 'Audio');
    await sendMedia('A', 'B', { uri, contentType: 'audio/mp4', durationMs: 4200, voiceNote: true });
    expect(existsSync(fromUri(uri))).toBe(false);
    await deliverRealtime('B');

    expect((await latest('B', 'A')).attachment).toMatchObject({
      kind: 'audio',
      voiceNote: true,
      durationMs: 4200,
      state: 'downloaded',
    });
    expect(plaintextOnDisk('B', Buffer.from('VOICE-PLAINTEXT-MARKER'))).toEqual([]);
    const [chat] = await as('B', (app) => app.messages.listConversations());
    expect(chat).toMatchObject({ lastAttachmentKind: 'audio', lastVoiceNote: 1, lastBody: '' });
  });

  it('a video arrives as a video with its duration', async () => {
    const uri = intake('A', Buffer.alloc(30_000, 3), 'clip.mp4');
    await sendMedia('A', 'B', {
      uri,
      contentType: 'video/mp4',
      durationMs: 12_000,
      width: 1280,
      height: 720,
    });
    await deliverRealtime('B');
    expect((await latest('B', 'A')).attachment).toMatchObject({
      kind: 'video',
      durationMs: 12_000,
      state: 'downloaded',
    });
  });

  it('refuses files over 100 MB and types it cannot show; the picker copy is still removed', async () => {
    const uri = intake('A', Buffer.alloc(1), 'big.mp4');
    truncateSync(fromUri(uri), 100 * 1024 * 1024 + 1);
    await expect(sendMedia('A', 'B', { uri, contentType: 'video/mp4' })).rejects.toMatchObject({
      code: 'MEDIA_TOO_LARGE',
    });
    expect(existsSync(fromUri(uri))).toBe(false);

    const pdf = intake('A', Buffer.from('%PDF-1.7'), 'doc.pdf');
    await expect(
      sendMedia('A', 'B', { uri: pdf, contentType: 'application/pdf' }),
    ).rejects.toMatchObject({ code: 'MEDIA_UNSUPPORTED' });
    expect(server.attachments).toHaveLength(0);
    expect(await conversation('A', 'B')).toEqual([]);
  });

  it('going to the background deletes every decrypted file', async () => {
    await sendMedia('A', 'B', photo('A'));
    await deliverRealtime('B');
    const message = await latest('B', 'A');
    await as('B', (app) => app.media.openAttachment(message.id));
    expect(plaintextOnDisk('B')).toHaveLength(1);

    await as('B', (app) => app.engine.handleAppStateChange('background'));
    expect(plaintextOnDisk('B')).toEqual([]);
    expect(apps.B.media.openPlaintextCount()).toBe(0);
  });

  it('after a kill, start-up removes plaintext leftovers, partial downloads and orphan blobs', async () => {
    await sendMedia('A', 'B', photo('A'));
    const keep = deviceFiles('A').find((f) => f.rel.startsWith('files/attachments/')).rel;
    const leftovers = [
      'cache/secure-media/viewing.jpg',
      'cache/ImagePicker/picked.jpg',
      'cache/Audio/recording-9.m4a',
      'files/attachments/abc.bin.part',
      'files/attachments/orphan.bin',
    ];
    for (const rel of leftovers) {
      mkdirSync(path.dirname(path.join(rootOf('A'), rel)), { recursive: true });
      writeFileSync(path.join(rootOf('A'), rel), MARKER);
    }

    apps.A.engine.stopMessaging();
    boot('A');
    await as('A', async (app) => {
      await app.auth.useAuthStore.getState().initialize();
      await app.engine.startMessaging(USERS.A.id);
    });

    const files = deviceFiles('A').map((f) => f.rel);
    for (const rel of leftovers) expect(files).not.toContain(rel);
    expect(files).toContain(keep);
    const sent = await latest('A', 'B');
    const opened = await as('A', (app) => app.media.openAttachment(sent.id));
    expect(readFileSync(fromUri(opened.uri)).equals(PHOTO)).toBe(true);
    opened.release();
  });

  it('signing out deletes all media, encrypted or not', async () => {
    await sendMedia('A', 'B', photo('A'));
    await deliverRealtime('B');
    await as('B', (app) => app.auth.useAuthStore.getState().logout());
    expect(deviceFiles('B').map((f) => f.rel)).toEqual([]);
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

  it('a held message that turns out to be internal content leaves no placeholder once accepted', async () => {
    await send('A', 'B', 'Hello');
    await deliverRealtime('B');
    await send('B', 'A', 'Hi A!');
    await deliverRealtime('A');
    await signInAgain('B');
    const attestation = require('../src/messaging/content').encodeContent({
      type: 'call.dtls',
      version: 1,
      callId: '11111111-1111-4111-8111-111111111111',
      role: 'caller',
      from: USERS.B.id,
      to: USERS.A.id,
      kind: 'voice',
      fingerprints: [`sha-256 ${Array(32).fill('CD').join(':')}`],
    });
    await sendingPlaintext(attestation, () => send('B', 'A', 'typed on this app'));
    await deliverRealtime('A');
    expect((await conversation('A', 'B'))[0]).toMatchObject({ status: 'identity_pending' });

    const change = await pendingChange('A', 'B');
    await accept('A', 'B', change.newIdentityKey);

    expect(await pendingChange('A', 'B')).toBeNull();
    expect((await conversation('A', 'B')).map((m) => [m.direction, m.body])).toEqual([
      ['in', 'Hi A!'],
      ['out', 'Hello'],
    ]);
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
    expect(realtime).toMatch(/apiRequest\('GET', ENDPOINTS\.REALTIME\.CONFIG\)/);
    expect(require('../src/config/endpoints').ENDPOINTS.REALTIME.CONFIG).toBe('/pusher/config');
  });
});

describe('online status and network changes', () => {
  const netChange = async (name, net) => {
    await as(name, () => {
      for (const listener of storage[name].netListeners ?? []) listener(net);
    });
  };
  const count = (method, path) =>
    server.requests.filter((r) => r.method === method && r.path.startsWith(path)).length;

  it('heartbeats while on screen; says goodbye in the background; beats again in the foreground', async () => {
    expect(server.presence.A).toBeDefined(); // the start-up subscribe sent one
    expect(server.presence.B).toBeDefined();

    await as('A', (app) => app.engine.handleAppStateChange('background'));
    expect(server.presence.A).toBeUndefined(); // DELETE /presence, not a wait for the TTL
    expect(server.presence.B).toBeDefined();

    await as('A', (app) => app.engine.handleAppStateChange('active'));
    expect(server.presence.A).toBeDefined();
    // The beat carries nothing but the session: no name, no number, no device details.
    const beat = server.requests.findLast(
      (r) => r.method === 'POST' && r.path === '/presence/heartbeat',
    );
    expect(beat.body).toBe('');
  });

  it('a network switch reconnects realtime, catches up over HTTPS and beats again', async () => {
    const auths = count('POST', '/pusher/auth');
    const syncs = count('GET', '/messages/envelopes');
    delete server.presence.A;

    await netChange('A', { isConnected: true, type: 'wifi', isInternetReachable: true });
    expect(count('POST', '/pusher/auth')).toBe(auths); // first report: nothing to re-do
    await netChange('A', { isConnected: true, type: 'cellular', isInternetReachable: true });

    expect(count('POST', '/pusher/auth')).toBe(auths + 1); // Pusher reconnected and re-subscribed
    expect(count('GET', '/messages/envelopes')).toBeGreaterThan(syncs);
    expect(server.presence.A).toBeDefined();
    expect(storage.A.pusher.state).toBe('connected');
  });

  it('Wi-Fi without internet is offline; once reachable, it syncs what it missed', async () => {
    await netChange('B', { isConnected: true, type: 'wifi', isInternetReachable: true });
    await netChange('B', { isConnected: true, type: 'wifi', isInternetReachable: false });
    expect(apps.B.engine.useMessagingStore.getState().online).toBe(false);
    const { connectivityStatus, useConnectivityStore } = apps.B.connectivity;
    expect(connectivityStatus(useConnectivityStore.getState(), 'connected')).toBe('offline');

    storage.B.pusher.drop();
    await send('A', 'B', 'while B had no internet');
    await deliverRealtime('B'); // lost
    expect(await conversation('B', 'A')).toEqual([]);

    await netChange('B', { isConnected: false, type: 'none' });
    await netChange('B', { isConnected: true, type: 'wifi', isInternetReachable: true });
    expect(apps.B.engine.useMessagingStore.getState().online).toBe(true);
    expect((await conversation('B', 'A'))[0].body).toBe('while B had no internet');
  });

  it('a replayed realtime event after a reconnect never duplicates a message', async () => {
    await send('A', 'B', 'once');
    await deliverRealtime('B');
    const event = server.published.findLast((e) => e.device === 'B' && e.event === 'envelope');
    await as('B', () => storage.B.pusher.deliver(event.channel, event.event, event.data));
    await as('B', () => storage.B.pusher.deliver(event.channel, event.event, event.data));
    expect((await conversation('B', 'A')).map((m) => m.body)).toEqual(['once']);
  });
});
