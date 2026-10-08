import { createHmac, randomUUID } from 'node:crypto';

import { CHANNEL_PREFIX, LIMITS } from '@secure-chat/shared/constants';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Message } from '../src/models/Message.js';
import { ENVELOPE_RETENTION, MessageEnvelope } from '../src/models/MessageEnvelope.js';
import {
  bearer,
  buildTestApp,
  connectTestDb,
  disconnectTestDb,
  dumpDatabase,
  login,
  newDevice,
  resetTestDb,
} from './helpers.js';
import { SignalTestDevice } from './signalTestDevice.js';

/**
 * Phase 3B: 1:1 messaging through the real API with two libsignal devices: send, realtime
 * (Pusher) events, offline recovery, idempotency, delivery/read receipts, channel auth.
 */
const ALICE = '+919876543210';
const BOB = '+919812345678';
const PUSHER_ENV = {
  PUSHER_APP_ID: '123456',
  PUSHER_KEY: 'test-pusher-key',
  PUSHER_SECRET: 'test-pusher-secret-value',
  PUSHER_CLUSTER: 'ap2',
};

let ctx;
let alice;
let bob;

async function makeDevice(phone) {
  const session = await login(ctx, phone, newDevice());
  const device = new SignalTestDevice({
    app: ctx.app,
    auth: {
      userId: session.user.id,
      deviceId: session.device.deviceId,
      accessToken: session.tokens.accessToken,
    },
  });
  expect((await device.registerKeys()).res.status).toBe(200);
  return device;
}

const peer = (device) => ({ userId: device.auth.userId, deviceId: device.auth.deviceId });
const api = (device) => ({
  post: (path, body) => request(ctx.app).post(path).set(bearer(device.auth.accessToken)).send(body),
  get: (path) => request(ctx.app).get(path).set(bearer(device.auth.accessToken)),
});
const eventsFor = (device, event) =>
  ctx.realtime.published.filter(
    (p) => p.channel === `${CHANNEL_PREFIX.DEVICE}${device.auth.deviceId}` && p.event === event,
  );

/** Receiver-side processing as the app does it: fetch, decrypt, then ack. */
async function receiveAll(device) {
  const res = await device.fetchEnvelopes();
  const texts = [];
  for (const envelope of res.body.envelopes) texts.push(await device.decrypt(envelope));
  if (res.body.envelopes.length > 0) {
    await api(device)
      .post('/messages/envelopes/ack', { upToSeq: res.body.envelopes.at(-1).seq })
      .expect(200);
  }
  return texts;
}

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  ctx = buildTestApp({ env: PUSHER_ENV });
  await ctx.redis.flushall();
  alice = await makeDevice(ALICE);
  bob = await makeDevice(BOB);
});

describe('POST /messages', () => {
  it('persists an encrypted message and reports it as sent', async () => {
    const sent = await alice.sendText(peer(bob), 'Hello');

    expect(sent.res.status).toBe(201);
    expect(sent.res.body).toEqual({
      messageId: expect.stringMatching(/^[a-f\d]{24}$/),
      clientMessageId: sent.body.clientMessageId,
      conversationId: [alice.auth.userId, bob.auth.userId].sort().join(':'),
      seq: 1,
      status: 'sent',
      createdAt: expect.any(String),
      duplicate: false,
    });

    const message = await Message.findById(sent.res.body.messageId).lean();
    expect(message).toMatchObject({ deliveredAt: null, readAt: null });
    const envelope = await MessageEnvelope.findOne({ messageId: message._id }).lean();
    expect(envelope).toMatchObject({
      recipientDeviceId: bob.auth.deviceId,
      senderDeviceId: alice.auth.deviceId,
      ciphertext: sent.body.ciphertext,
    });
  });

  it('requires authentication', async () => {
    const res = await request(ctx.app).post('/messages').send({});
    expect(res.status).toBe(401);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('validates the recipient (unknown user, wrong device, yourself)', async () => {
    const base = {
      clientMessageId: randomUUID(),
      type: 2,
      ciphertext: Buffer.from('opaque').toString('base64'),
    };
    const cases = [
      { recipientUserId: '507f1f77bcf86cd799439011', recipientDeviceId: bob.auth.deviceId },
      { recipientUserId: bob.auth.userId, recipientDeviceId: randomUUID() },
      { recipientUserId: bob.auth.userId, recipientDeviceId: alice.auth.deviceId },
    ];
    for (const recipient of cases) {
      const res = await api(alice).post('/messages', { ...base, ...recipient });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('STALE_RECIPIENT_DEVICE');
    }
    const self = await api(alice).post('/messages', {
      ...base,
      recipientUserId: alice.auth.userId,
      recipientDeviceId: alice.auth.deviceId,
    });
    expect(self.status).toBe(400);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('rejects ciphertext for keys the recipient no longer has (signed in again, same device)', async () => {
    const base = {
      recipientUserId: bob.auth.userId,
      recipientDeviceId: bob.auth.deviceId,
      type: 2,
      ciphertext: Buffer.from('opaque').toString('base64'),
    };
    const current = bob.state.registrationId;
    const other = (current % 16380) + 1;

    const stale = await api(alice).post('/messages', {
      ...base,
      clientMessageId: randomUUID(),
      recipientRegistrationId: other,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_RECIPIENT_DEVICE');
    expect(await Message.countDocuments()).toBe(0);

    // Matching registration id, or none at all (older apps): accepted as before.
    for (const extra of [{ recipientRegistrationId: current }, {}]) {
      const ok = await api(alice).post('/messages', {
        ...base,
        clientMessageId: randomUUID(),
        ...extra,
      });
      expect(ok.status).toBe(201);
    }
    const invalid = await api(alice).post('/messages', {
      ...base,
      clientMessageId: randomUUID(),
      recipientRegistrationId: 0,
    });
    expect(invalid.status).toBe(400);
  });

  it('rejects invalid payloads and plaintext fields', async () => {
    const valid = {
      recipientUserId: bob.auth.userId,
      recipientDeviceId: bob.auth.deviceId,
      clientMessageId: randomUUID(),
      type: 2,
      ciphertext: Buffer.from('opaque').toString('base64'),
    };
    const invalid = [
      { ...valid, ciphertext: 'not base64!' },
      { ...valid, ciphertext: '' },
      { ...valid, type: 1 },
      { ...valid, clientMessageId: 'not-a-uuid' },
      { ...valid, recipientUserId: { $ne: null } },
      { ...valid, body: 'Hello' },
      { ...valid, plaintext: 'Hello' },
    ];
    for (const body of invalid) {
      const res = await api(alice).post('/messages', body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await Message.countDocuments()).toBe(0);
  });

  it('rejects oversized payloads', async () => {
    const tooBig = Buffer.alloc(70 * 1024, 1).toString('base64'); // > 64 KB ciphertext limit
    const res = await api(alice).post('/messages', {
      recipientUserId: bob.auth.userId,
      recipientDeviceId: bob.auth.deviceId,
      clientMessageId: randomUUID(),
      type: 2,
      ciphertext: tooBig,
    });
    expect([400, 413]).toContain(res.status);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('is idempotent: retries return the original message without a duplicate', async () => {
    const sent = await alice.sendText(peer(bob), 'only once');
    const retries = await Promise.all([1, 2, 3].map(() => api(alice).post('/messages', sent.body)));

    for (const retry of retries) {
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({
        messageId: sent.res.body.messageId,
        seq: sent.res.body.seq,
        duplicate: true,
      });
    }
    expect(await Message.countDocuments()).toBe(1);
    expect(await MessageEnvelope.countDocuments()).toBe(1);
    expect(eventsFor(bob, 'envelope')).toHaveLength(1);
    expect(await receiveAll(bob)).toEqual(['only once']);
  });

  it('handles concurrent first attempts with the same clientMessageId', async () => {
    const clientMessageId = randomUUID();
    const sent = await alice.sendText(peer(bob), 'race', { clientMessageId });
    await Message.deleteMany({});
    await MessageEnvelope.deleteMany({});

    const results = await Promise.all([
      api(alice).post('/messages', sent.body),
      api(alice).post('/messages', sent.body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await Message.countDocuments({ clientMessageId })).toBe(1);
  });

  it('refuses to reuse a clientMessageId for a different recipient', async () => {
    const carol = await makeDevice('+919811112222');
    const sent = await alice.sendText(peer(bob), 'to bob');
    const res = await api(alice).post('/messages', {
      ...sent.body,
      recipientUserId: carol.auth.userId,
      recipientDeviceId: carol.auth.deviceId,
    });
    expect(res.status).toBe(409);
  });
});

describe('access control between users and devices', () => {
  it('a user can never list, acknowledge or mark read envelopes addressed to someone else', async () => {
    const sent = await alice.sendText(peer(bob), 'for Bob only');
    const messageId = sent.res.body.messageId;

    // Alice (the sender) and an unrelated user see nothing of Bob's inbox.
    const carol = await makeDevice('+919811100000');
    for (const intruder of [alice, carol]) {
      const list = await api(intruder).get('/messages/envelopes?after=0');
      expect(list.status).toBe(200);
      expect(list.body.envelopes).toEqual([]);
      const ack = await api(intruder).post('/messages/envelopes/ack', { upToSeq: 1_000_000 });
      expect(ack.body.acknowledged).toBe(0);
      const read = await api(intruder).post('/messages/read', { messageIds: [messageId] });
      expect(read.body.updated).toBe(0);
    }
    // Carol cannot see the status of a message she did not send.
    const status = await api(carol).post('/messages/status', { messageIds: [messageId] });
    expect(status.body.statuses).toEqual([]);

    const envelope = await MessageEnvelope.findOne({ messageId }).lean();
    expect(envelope.deliveredAt).toBeNull();
    expect((await Message.findById(messageId).lean()).readAt).toBeNull();
    expect(await receiveAll(bob)).toEqual(['for Bob only']);
  });

  it('a replaced device loses access at once; the new device never gets the old device’s envelopes', async () => {
    await alice.sendText(peer(bob), 'to the old phone');
    await ctx.redis.flushall(); // OTP resend cooldown for Bob's number
    const bobNew = await makeDevice(BOB); // Bob signs in on another phone

    for (const path of ['/messages/envelopes?after=0', '/keys/status', '/pusher/config']) {
      expect((await api(bob).get(path)).status).toBe(401);
    }
    expect((await api(bobNew).get('/messages/envelopes?after=0')).body.envelopes).toEqual([]);

    // A sender with a session for the old device is told to fetch the new keys.
    const stale = await api(alice).post('/messages', {
      recipientUserId: bob.auth.userId,
      recipientDeviceId: bob.auth.deviceId,
      clientMessageId: randomUUID(),
      type: 2,
      ciphertext: Buffer.from('opaque').toString('base64'),
    });
    expect(stale.body.error.code).toBe('STALE_RECIPIENT_DEVICE');
  });

  it('envelopes expire on the server: TTL index, 30 days undelivered, 7 days after delivery', async () => {
    const sent = await alice.sendText(peer(bob), 'expiring');
    const envelope = await MessageEnvelope.findOne({ messageId: sent.res.body.messageId }).lean();
    const ttl = (await MessageEnvelope.collection.indexes()).find((i) => i.key.expiresAt === 1);
    expect(ttl.expireAfterSeconds).toBe(0);
    const day = 24 * 60 * 60 * 1000;
    expect(envelope.expiresAt - envelope.createdAt).toBeGreaterThan(29 * day);
    expect(envelope.expiresAt - envelope.createdAt).toBeLessThanOrEqual(30 * day + 1000);

    await receiveAll(bob);
    const acked = await MessageEnvelope.findById(envelope._id).lean();
    expect(acked.expiresAt - acked.deliveredAt).toBe(ENVELOPE_RETENTION.DELIVERED_MS);
    // Message metadata has its own TTL too.
    const messageTtl = (await Message.collection.indexes()).find((i) => i.key.expiresAt === 1);
    expect(messageTtl.expireAfterSeconds).toBe(0);
  });
});

describe('realtime (Pusher) events', () => {
  it('publishes the encrypted envelope to the recipient device channel only', async () => {
    const text = 'Hello Bob, realtime';
    const sent = await alice.sendText(peer(bob), text);

    expect(ctx.realtime.published).toHaveLength(1);
    const [event] = eventsFor(bob, 'envelope');
    expect(event.payload).toMatchObject({
      envelopeId: expect.any(String),
      seq: 1,
      inline: true,
      envelope: { messageId: sent.res.body.messageId, ciphertext: sent.body.ciphertext },
    });
    expect(JSON.stringify(ctx.realtime.published)).not.toContain(text);
    expect(await bob.decrypt(event.payload.envelope)).toBe(text);
  });

  it('falls back to an id-only event for large envelopes; the device fetches over HTTPS', async () => {
    const large = 'L'.repeat(LIMITS.PUSHER_INLINE_PAYLOAD_BYTES);
    await alice.sendText(peer(bob), large);

    const [event] = eventsFor(bob, 'envelope');
    expect(event.payload).toEqual({ envelopeId: expect.any(String), seq: 1, inline: false });
    expect(await receiveAll(bob)).toEqual([large]);
  });

  it('keeps the message when Pusher fails; the receiver recovers it by sync', async () => {
    ctx.realtime.publish = async () => {
      throw new Error('Pusher unavailable');
    };

    const sent = await alice.sendText(peer(bob), 'survives Pusher outage');

    expect(sent.res.status).toBe(201);
    expect(ctx.lines.some((l) => l.msg === 'Realtime publish failed; client will sync')).toBe(true);
    expect(await receiveAll(bob)).toEqual(['survives Pusher outage']);
  });
});

describe('offline recovery', () => {
  it('delivers everything sent while the receiver was offline, in order, exactly once', async () => {
    const texts = ['one', 'two', 'three'];
    for (const text of texts) await alice.sendText(peer(bob), text);

    // Bob was offline: he missed the realtime events and syncs when he reconnects.
    expect(await receiveAll(bob)).toEqual(texts);
    // Acknowledged envelopes are not returned again.
    expect((await bob.fetchEnvelopes()).body.envelopes).toEqual([]);
  });

  it('pages through pending envelopes with the seq cursor', async () => {
    for (let i = 0; i < 3; i += 1) await alice.sendText(peer(bob), `m${i}`);

    const page1 = await api(bob).get('/messages/envelopes?after=0&limit=2');
    expect(page1.body.envelopes.map((e) => e.seq)).toEqual([1, 2]);
    const page2 = await api(bob).get('/messages/envelopes?after=2&limit=2');
    expect(page2.body.envelopes.map((e) => e.seq)).toEqual([3]);
  });

  it('acknowledgement keeps the envelope for the retention period instead of deleting it', async () => {
    await alice.sendText(peer(bob), 'keep me');
    const before = await MessageEnvelope.findOne().lean();
    expect(before.expiresAt.getTime() - before.createdAt.getTime()).toBeCloseTo(
      ENVELOPE_RETENTION.UNDELIVERED_MS,
      -4,
    );

    await receiveAll(bob);

    const after = await MessageEnvelope.findOne().lean();
    expect(after.deliveredAt).toBeInstanceOf(Date);
    expect(after.expiresAt.getTime() - after.deliveredAt.getTime()).toBe(
      ENVELOPE_RETENTION.DELIVERED_MS,
    );
    const indexes = await MessageEnvelope.collection.indexes();
    expect(indexes.find((i) => i.key.expiresAt)).toMatchObject({ expireAfterSeconds: 0 });
  });
});

describe('delivery and read state', () => {
  it('ack marks messages delivered and notifies the sender device', async () => {
    const sent = await alice.sendText(peer(bob), 'deliver me');
    await receiveAll(bob);

    const message = await Message.findById(sent.res.body.messageId).lean();
    expect(message.deliveredAt).toBeInstanceOf(Date);
    expect(message.readAt).toBeNull();

    const [receipt] = eventsFor(alice, 'receipt');
    expect(receipt.payload).toEqual({
      receipts: [
        { messageId: sent.res.body.messageId, status: 'delivered', at: expect.any(String) },
      ],
    });

    const status = await api(alice).post('/messages/status', {
      messageIds: [sent.res.body.messageId],
    });
    expect(status.body.statuses).toEqual([
      expect.objectContaining({ messageId: sent.res.body.messageId, status: 'delivered' }),
    ]);
  });

  it('read receipts mark messages read and notify the sender', async () => {
    const sent = await alice.sendText(peer(bob), 'read me');
    await receiveAll(bob);

    const res = await api(bob).post('/messages/read', { messageIds: [sent.res.body.messageId] });
    expect(res.body).toEqual({ updated: 1 });
    // Idempotent.
    expect(
      (await api(bob).post('/messages/read', { messageIds: [sent.res.body.messageId] })).body,
    ).toEqual({ updated: 0 });

    const receipts = eventsFor(alice, 'receipt').flatMap((e) => e.payload.receipts);
    expect(receipts.map((r) => r.status)).toEqual(['delivered', 'read']);
    const status = await api(alice).post('/messages/status', {
      messageIds: [sent.res.body.messageId],
    });
    expect(status.body.statuses[0].status).toBe('read');
    // A duplicate send now also reports the current state.
    expect((await api(alice).post('/messages', sent.body)).body.status).toBe('read');
  });

  it('only the recipient can mark read, and only the sender can see status', async () => {
    const sent = await alice.sendText(peer(bob), 'private state');
    const id = sent.res.body.messageId;

    expect((await api(alice).post('/messages/read', { messageIds: [id] })).body.updated).toBe(0);
    expect((await api(bob).post('/messages/status', { messageIds: [id] })).body.statuses).toEqual(
      [],
    );
    expect(await Message.countDocuments({ readAt: { $ne: null } })).toBe(0);
  });

  it('validates receipt batches', async () => {
    for (const messageIds of [[], ['nope'], Array(101).fill('507f1f77bcf86cd799439011')]) {
      expect((await api(bob).post('/messages/read', { messageIds })).status).toBe(400);
    }
  });
});

describe('POST /pusher/auth', () => {
  const socketId = '123456.7890123';
  const ownChannel = (device) => `private-device-${device.auth.deviceId}`;

  it('signs the caller’s own device channel with the server-side secret', async () => {
    const res = await api(bob).post('/pusher/auth', { socketId, channelName: ownChannel(bob) });

    expect(res.status).toBe(200);
    const signature = createHmac('sha256', PUSHER_ENV.PUSHER_SECRET)
      .update(`${socketId}:${ownChannel(bob)}`)
      .digest('hex');
    expect(res.body).toEqual({ auth: `${PUSHER_ENV.PUSHER_KEY}:${signature}` });
    expect(JSON.stringify(res.body)).not.toContain(PUSHER_ENV.PUSHER_SECRET);
  });

  it('rejects other devices’ channels and arbitrary channels', async () => {
    for (const channelName of [
      ownChannel(alice),
      `private-device-${randomUUID()}`,
      'private-chat-123',
      'presence-chat-1',
      'public-news',
      `${ownChannel(bob)}x`,
    ]) {
      const res = await api(bob).post('/pusher/auth', { socketId, channelName });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('requires authentication and a valid socket id', async () => {
    await request(ctx.app)
      .post('/pusher/auth')
      .send({ socketId, channelName: ownChannel(bob) })
      .expect(401);
    const bad = await api(bob).post('/pusher/auth', {
      socketId: '1.2;evil',
      channelName: ownChannel(bob),
    });
    expect(bad.status).toBe(400);
  });

  it('serves only the public key and cluster to the app', async () => {
    const res = await api(bob).get('/pusher/config');
    expect(res.body).toEqual({
      realtime: { key: PUSHER_ENV.PUSHER_KEY, cluster: PUSHER_ENV.PUSHER_CLUSTER },
      channel: ownChannel(bob),
    });
    expect(JSON.stringify(res.body)).not.toContain(PUSHER_ENV.PUSHER_SECRET);
  });

  it('returns 503 when Pusher is not configured', async () => {
    const plain = buildTestApp();
    const res = await request(plain.app)
      .post('/pusher/auth')
      .set(bearer(bob.auth.accessToken))
      .send({ socketId, channelName: ownChannel(bob) });
    expect(res.status).toBe(503);
    const config = await request(plain.app).get('/pusher/config').set(bearer(bob.auth.accessToken));
    expect(config.body.realtime).toBeNull();
  });
});

describe('no plaintext anywhere on the server side', () => {
  it('MongoDB, realtime events, API responses and logs never contain message text', async () => {
    const texts = ['Hello', 'Top secret plan 🔐', 'reply text'];
    const responses = [];
    const keep = (res) => {
      responses.push(JSON.stringify(res.body));
      return res;
    };

    keep((await alice.sendText(peer(bob), texts[0])).res);
    keep((await alice.sendText(peer(bob), texts[1])).res);
    const inbox = keep(await bob.fetchEnvelopes());
    for (const envelope of inbox.body.envelopes) await bob.decrypt(envelope);
    keep(await api(bob).post('/messages/envelopes/ack', { upToSeq: 2 }));
    keep((await bob.sendText(peer(alice), texts[2])).res);
    keep(
      await api(alice).post('/messages/status', {
        messageIds: [inbox.body.envelopes[0].messageId],
      }),
    );

    const haystacks = {
      database: await dumpDatabase(),
      realtime: JSON.stringify(ctx.realtime.published),
      responses: responses.join('\n'),
      logs: JSON.stringify(ctx.lines),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const secret of texts) {
        expect(text.includes(secret), `"${secret}" found in ${where}`).toBe(false);
        expect(text.includes(Buffer.from(secret).toString('base64')), `base64 in ${where}`).toBe(
          false,
        );
      }
    }
  });

  it('private keys never reach the server, Pusher or logs', async () => {
    await alice.sendText(peer(bob), 'x');
    await receiveAll(bob);
    const haystack = [
      await dumpDatabase(),
      JSON.stringify(ctx.realtime.published),
      JSON.stringify(ctx.lines),
    ].join('\n');
    for (const secret of [...alice.privateKeyMaterial(), ...bob.privateKeyMaterial()]) {
      expect(haystack.includes(secret)).toBe(false);
    }
    expect(haystack.includes(PUSHER_ENV.PUSHER_SECRET)).toBe(false);
  });
});
