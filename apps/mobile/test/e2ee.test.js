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
      db: require('../src/db/database'),
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
    failNextPut: 0,
  };
  const userByToken = (headers) =>
    Object.keys(USERS).find((k) => headers.Authorization === `Bearer token-${k}`);
  // Same shape as GET /keys/status of the API.
  const statusOf = (d) => ({
    registered: Boolean(d?.signal),
    signedPreKeyId: d?.signal?.signedPreKey.keyId ?? null,
    kyberPreKeyId: d?.signal?.kyberPreKey.keyId ?? null,
    oneTimePreKeyCount: d?.oneTime.length ?? 0,
  });

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
        return { body: { status: statusOf(d) } };
      },
    ],
    [
      'PUT',
      /^\/keys$/,
      ({ me, body }) => {
        if (state.failNextPut > 0) {
          state.failNextPut -= 1;
          return { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE' } } };
        }
        // Like the API: new signed/Kyber keys replace the old ones, one-time keys are added.
        const { oneTimePreKeys = [], ...signal } = body;
        const existing = state.devices[USERS[me].id];
        state.devices[USERS[me].id] = {
          deviceId: USERS[me].deviceId,
          signal,
          oneTime: [...(existing?.oneTime ?? []), ...oneTimePreKeys],
        };
        return { body: { status: statusOf(state.devices[USERS[me].id]) } };
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

  it('a replayed ciphertext (same Signal message under a new envelope id) is never shown twice', async () => {
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'only once'));
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));
    // A malicious or buggy server re-delivers the same ciphertext as a "new" message.
    const original = server.envelopes[0];
    server.seq += 1;
    server.envelopes.push({
      ...original,
      envelopeId: `env-${server.seq}`,
      seq: server.seq,
      messageId: `msg-${server.seq}`,
      delivered: false,
    });

    const result = await as('B', (app) => app.signal.syncInbox(USERS.B.id));
    // libsignal refuses it (its one-time pre-key is already used and deleted): the text is
    // never produced a second time. At most an unreadable placeholder appears, exactly as
    // for any garbage a server could inject.
    expect(result).toEqual({ received: 0, failed: 1 });
    const inbox = await as('B', (app) => app.signal.listConversation(USERS.A.id));
    expect(inbox.filter((m) => m.body === 'only once')).toHaveLength(1);
    expect(inbox.filter((m) => m.status === 'received')).toHaveLength(1);
  });

  it('a replayed message on an established session is dropped silently as a duplicate', async () => {
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'ping'));
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));
    await as('B', (app) => app.signal.sendText(USERS.B.id, USERS.A.id, 'pong'));
    await as('A', (app) => app.signal.syncInbox(USERS.A.id));
    const whisper = await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'again'));
    expect(whisper.type).toBe(2);
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));

    const original = server.envelopes.at(-1);
    server.seq += 1;
    server.envelopes.push({
      ...original,
      envelopeId: `env-${server.seq}`,
      seq: server.seq,
      messageId: `msg-${server.seq}`,
      delivered: false,
    });
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));

    const inbox = await as('B', (app) => app.signal.listConversation(USERS.A.id));
    // No copy and no placeholder ('pong' is B's own outgoing message).
    expect(inbox.map((m) => m.body)).toEqual(['again', 'pong', 'ping']);
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

describe('signed and Kyber pre-key rotation', () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** Moves device `name`'s signed/Kyber pre-keys `days` into the past (as if time passed). */
  const age = (name, days) =>
    as(name, async (app) => {
      const db = app.db.getDatabase();
      for (const table of ['signal_signed_prekeys', 'signal_kyber_prekeys']) {
        await db.runAsync(`UPDATE ${table} SET created_at = created_at - ?;`, days * DAY);
      }
    });
  const localIds = (name, table) =>
    as(name, async (app) =>
      (await app.db.getDatabase().getAllAsync(`SELECT key_id AS id FROM ${table};`)).map(
        (r) => r.id,
      ),
    );
  const keyUploads = () => server.requests.filter((r) => r.method === 'PUT' && r.path === '/keys');
  const served = (name) => server.devices[USERS[name].id].signal;
  const maintain = (name) => as(name, (app) => app.signal.ensureKeysRegistered());

  it('keeps the signed and Kyber pre-keys for 7 days (no rotation before)', async () => {
    const before = keyUploads().length;
    await age('B', 6);
    await maintain('B');
    expect(keyUploads().length).toBe(before);
  });

  it('rotates after 7 days: new public keys only, same identity, in-flight first messages still decrypt', async () => {
    const old = { ...served('B') };
    // A starts a session with B's CURRENT keys; the message is still on the server.
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'sent before rotation'));

    await age('B', 8);
    await maintain('B');

    const upload = JSON.parse(keyUploads().at(-1).body);
    expect(Object.keys(upload).sort()).toEqual(
      ['identityKey', 'kyberPreKey', 'registrationId', 'signedPreKey'].sort(),
    );
    expect(Object.keys(upload.signedPreKey).sort()).toEqual(['keyId', 'publicKey', 'signature']);
    expect(upload.identityKey).toBe(old.identityKey);
    expect(upload.registrationId).toBe(old.registrationId);
    expect(served('B').signedPreKey.keyId).not.toBe(old.signedPreKey.keyId);
    expect(served('B').kyberPreKey.keyId).not.toBe(old.kyberPreKey.keyId);
    expect(server.devices[USERS.B.id].oneTime.length).toBeGreaterThan(0); // untouched

    // The old private keys are still on the phone, so the in-flight message decrypts.
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));
    expect((await as('B', (app) => app.signal.listConversation(USERS.A.id)))[0]).toMatchObject({
      body: 'sent before rotation',
      status: 'received',
    });

    // A brand-new session now uses the new keys and works too.
    await as('A', async (app) => {
      await app.store.deleteSession(app.store.addressOf(USERS.B.id));
      await app.store.deletePeerDevice(USERS.B.id);
    });
    await as('A', (app) => app.signal.sendText(USERS.A.id, USERS.B.id, 'after rotation'));
    await as('B', (app) => app.signal.syncInbox(USERS.B.id));
    expect((await as('B', (app) => app.signal.listConversation(USERS.A.id)))[0].body).toBe(
      'after rotation',
    );
  });

  it('deletes a replaced private key 35 days after its replacement, never the served one', async () => {
    const [first] = await localIds('B', 'signal_signed_prekeys');
    await age('B', 8);
    await maintain('B'); // rotation 1: first -> second
    const second = served('B').signedPreKey.keyId;

    await age('B', 34); // second replaced first 34 days ago: first must still be kept
    await maintain('B'); // rotation 2 (second is 34 days old)
    expect(await localIds('B', 'signal_signed_prekeys')).toEqual(
      expect.arrayContaining([first, second]),
    );

    await age('B', 2); // now 36 days since first was replaced
    await maintain('B');
    const ids = await localIds('B', 'signal_signed_prekeys');
    expect(ids).not.toContain(first);
    expect(ids).toContain(served('B').signedPreKey.keyId);
    expect((await localIds('B', 'signal_kyber_prekeys')).length).toBe(ids.length);
  });

  it('a failed upload is retried later, and messaging is never blocked by it', async () => {
    const old = served('B').signedPreKey.keyId;
    await age('B', 8);
    server.failNextPut = 1;
    await expect(maintain('B')).resolves.toBeDefined(); // no error surfaces
    expect(served('B').signedPreKey.keyId).toBe(old); // server still has the old keys

    await maintain('B'); // the server is behind: upload again
    expect(served('B').signedPreKey.keyId).not.toBe(old);
    const newest = await as('B', (app) => app.store.newestRotatedPreKey('signed'));
    expect(served('B').signedPreKey.keyId).toBe(newest.keyId);
    // The key the server served meanwhile was never deleted.
    expect(await localIds('B', 'signal_signed_prekeys')).toContain(old);
  });
});
