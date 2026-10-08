/* global jest */
import { LIMITS } from '@secure-chat/shared/constants';

/**
 * Two complete instances of the mobile app (device A and device B), each with its own simulated
 * SecureStore and SQLCipher database, talking through an in-memory backend that implements the
 * real API contract. Crypto is the official libsignal (see mocks/signalNativeMock.js).
 */
const USERS = {
  A: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', phone: '+919876543210', deviceId: null },
  B: { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', phone: '+919812345678', deviceId: null },
};

const freshStorage = () => ({
  secureStore: new Map(),
  sqliteFiles: new Map(),
  sqliteBroken: false,
});

let storage;
let apps;
let server;

/** Load (or reload, after a "force-close") the app modules for one device. */
function boot(name) {
  globalThis.__device = storage[name];
  let app;
  jest.isolateModules(() => {
    app = {
      auth: require('../src/auth/authStore'),
      signal: require('../src/crypto/signalService'),
      store: require('../src/crypto/signalStore'),
    };
  });
  apps[name] = app;
  return app;
}

/** Run `fn` with device `name`'s storage active (calls are sequential in these tests). */
async function as(name, fn) {
  globalThis.__device = storage[name];
  return fn(apps[name]);
}

function createServer() {
  const state = {
    devices: {}, // userId -> { deviceId, signal, oneTime: [] }
    envelopes: [], // { recipientUserId, seq, ... }
    seq: 0,
    requests: [],
    published: [],
  };
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
            status: {
              registered: Boolean(d?.signal),
              oneTimePreKeyCount: d?.oneTime.length ?? 0,
            },
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
        state.seq += 1;
        const envelope = {
          envelopeId: `env-${state.seq}`,
          seq: state.seq,
          messageId: `msg-${state.seq}`,
          senderUserId: USERS[me].id,
          senderDeviceId: USERS[me].deviceId,
          senderSignalDeviceId: 1,
          recipientUserId: body.recipientUserId,
          type: body.type,
          ciphertext: body.ciphertext,
          createdAt: new Date().toISOString(),
          delivered: false,
        };
        state.envelopes.push(envelope);
        const inline = JSON.stringify(envelope).length <= LIMITS.PUSHER_INLINE_PAYLOAD_BYTES;
        state.published.push(
          inline
            ? { envelopeId: envelope.envelopeId, seq: envelope.seq, inline: true, envelope }
            : { envelopeId: envelope.envelopeId, seq: envelope.seq, inline: false },
        );
        return { status: 201, body: { messageId: envelope.messageId, seq: envelope.seq } };
      },
    ],
    [
      'GET',
      /^\/messages\/envelopes\?after=(\d+)$/,
      ({ me, match }) => ({
        body: {
          envelopes: state.envelopes.filter(
            (e) => e.recipientUserId === USERS[me].id && e.seq > Number(match[1]) && !e.delivered,
          ),
        },
      }),
    ],
    [
      'POST',
      /^\/messages\/envelopes\/ack$/,
      ({ me, body }) => {
        for (const e of state.envelopes) {
          if (e.recipientUserId === USERS[me].id && e.seq <= body.upToSeq) e.delivered = true;
        }
        return { body: { acknowledged: 1 } };
      },
    ],
    ['POST', /^\/auth\/logout$/, () => ({ status: 204 })],
  ];

  global.fetch = jest.fn(async (url, init = {}) => {
    const path = url.replace('http://api.test', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.requests.push({ method, path, body: init.body ?? '' });
    for (const [m, re, handler] of handlers) {
      const match = m === method && re.exec(path);
      if (match) {
        const res = handler({ body, match, me: userByToken(init.headers ?? {}) });
        return {
          status: res.status ?? 200,
          json: async () => res.body ?? null,
          headers: { get: () => null },
        };
      }
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  return state;
}

async function signInAndRegister(name) {
  await as(name, async (app) => {
    await app.auth.useAuthStore.getState().verifyOtp(USERS[name].phone, '123456');
    await app.signal.ensureKeysRegistered();
  });
}

const allRequestBodies = () => server.requests.map((r) => r.body).join('\n');

beforeEach(async () => {
  storage = { A: freshStorage(), B: freshStorage() };
  apps = {};
  server = createServer();
  boot('A');
  boot('B');
  await signInAndRegister('A');
  await signInAndRegister('B');
});

describe('E2EE between two app instances', () => {
  it('A encrypts, the server relays ciphertext only, B decrypts the original text', async () => {
    const text = 'Hi B, this is end-to-end encrypted 🔐';

    const sent = await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, text));
    expect(sent.type).toBe(3); // first message: PreKeySignalMessage

    const post = server.requests.find((r) => r.method === 'POST' && r.path === '/messages');
    expect(post.body).not.toContain(text);
    expect(JSON.parse(post.body).ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const result = await as('B', (app) => app.signal.syncInbox(USERS.B.id));
    expect(result).toEqual({ received: 1, failed: 0 });
    const inbox = await as('B', (app) => app.signal.listConversation(USERS.A.id));
    expect(inbox[0]).toMatchObject({ direction: 'in', body: text, status: 'received' });

    const outbox = await as('A', (app) => app.signal.listConversation(USERS.B.id));
    expect(outbox[0]).toMatchObject({ direction: 'out', body: text, status: 'sent' });
  });

  it('ratchets in both directions (PreKey then Signal messages)', async () => {
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'ping'));
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));
    const reply = await as('B', (app) => app.signal.sendText(USERS.B.id, USERS.A.id, 'pong'));
    expect(reply.type).toBe(2);
    await as('A', (app) => app.signal.syncInbox(USERS.A.id));
    const more = await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'again'));
    expect(more.type).toBe(2);
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));

    const bodies = (await as('B', (app) => app.signal.listConversation(USERS.A.id))).map(
      (m) => m.body,
    );
    expect(bodies).toEqual(['again', 'pong', 'ping']);
  });

  it('session state survives a force-close of both apps', async () => {
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'before'));
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));

    // Force-close: all JS state gone, storage (SecureStore + SQLCipher) kept.
    for (const name of ['A', 'B']) {
      boot(name);
      await as(name, (app) => app.auth.useAuthStore.getState().initialize());
    }
    const bundleFetches = () => server.requests.filter((r) => r.path.startsWith('/keys/bundle'));
    const before = bundleFetches().length;

    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'after restart'));
    expect(bundleFetches().length).toBe(before); // existing session reused
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));
    const inbox = await as('B', (app) => app.signal.listConversation(USERS.A.id));
    expect(inbox[0].body).toBe('after restart');
  });

  it('processes envelopes stored before a crash, exactly once', async () => {
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'survives crash'));
    // B receives the realtime event and stores the envelope, then "crashes" before decrypting.
    const event = server.published.at(-1);
    await as('B', (app) => app.store.insertEnvelopeIfNew({ ...event.envelope }));
    boot('B');
    await as('B', (app) => app.auth.useAuthStore.getState().initialize());

    await as('B', (app) => app.signal.syncInbox(USERS.B.id));
    await as('B', (app) => app.signal.syncInbox(USERS.B.id)); // again: no duplicates
    const inbox = await as('B', (app) => app.signal.listConversation(USERS.A.id));
    expect(inbox.map((m) => m.body)).toEqual(['survives crash']);
  });

  it('handles inline realtime envelopes and id-only events for large envelopes', async () => {
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'small'));
    expect(server.published.at(-1).inline).toBe(true);
    await as('B', (app) => app.signal.handleRealtimeEnvelope(USERS.B.id, server.published.at(-1)));

    const large = 'L'.repeat(LIMITS.PUSHER_INLINE_PAYLOAD_BYTES);
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, large));
    const event = server.published.at(-1);
    expect(event).toEqual({
      envelopeId: expect.any(String),
      seq: expect.any(Number),
      inline: false,
    });
    await as('B', (app) => app.signal.handleRealtimeEnvelope(USERS.B.id, event));

    const inbox = await as('B', (app) => app.signal.listConversation(USERS.A.id));
    expect(inbox.map((m) => m.body)).toEqual([large, 'small']);
  });
});

describe('key handling security', () => {
  it('uploads public keys only: no private key material ever leaves the device', async () => {
    const secrets = [];
    for (const name of ['A', 'B']) {
      const identity = JSON.parse(storage[name].secureStore.get('signal.identity'));
      secrets.push(identity.identityKeyPair);
      const records = await as(name, async (app) => [
        ...(await app.store.loadAllSignedPreKeys()),
        ...(await app.store.loadAllKyberPreKeys()),
      ]);
      secrets.push(...records);
    }
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'x'));

    const sent = allRequestBodies();
    for (const secret of secrets) expect(sent.includes(secret)).toBe(false);

    const keysUpload = JSON.parse(server.requests.find((r) => r.method === 'PUT').body);
    expect(Object.keys(keysUpload).sort()).toEqual(
      ['identityKey', 'kyberPreKey', 'oneTimePreKeys', 'registrationId', 'signedPreKey'].sort(),
    );
    expect(Object.keys(keysUpload.oneTimePreKeys[0]).sort()).toEqual(['keyId', 'publicKey']);
  });

  it('keeps the identity key pair in SecureStore, not in the database', async () => {
    expect(storage.A.secureStore.has('signal.identity')).toBe(true);
    const identity = JSON.parse(storage.A.secureStore.get('signal.identity'));
    const dbBytes = Buffer.from(storage.A.sqliteFiles.get('securechat.db').db.export());
    expect(dbBytes.includes(Buffer.from(identity.identityKeyPair))).toBe(false);
  });

  it('removes a one-time pre-key locally once it has been used', async () => {
    const before = await as('B', (app) => app.store.countLocalPreKeys());
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'uses a one-time key'));
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));
    expect(await as('B', (app) => app.store.countLocalPreKeys())).toBe(before - 1);
  });

  it('logout wipes the identity key, sessions, pre-keys and messages', async () => {
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'bye'));
    await as('A', (app) => app.auth.useAuthStore.getState().logout());

    expect(storage.A.secureStore.has('signal.identity')).toBe(false);
    expect(storage.A.secureStore.has('db.key')).toBe(false);
    expect(storage.A.sqliteFiles.has('securechat.db')).toBe(false);
    expect([...storage.A.secureStore.keys()]).toEqual(['device.id']);
  });
});
