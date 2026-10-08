import { CHANNEL_PREFIX, LIMITS } from '@secure-chat/shared/constants';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Device } from '../src/models/Device.js';
import {
  bearer,
  buildTestApp,
  clearCooldowns,
  connectTestDb,
  disconnectTestDb,
  dumpDatabase,
  login,
  newDevice,
  resetTestDb,
} from './helpers.js';
import { SignalTestDevice } from './signalTestDevice.js';

/**
 * End-to-end encryption through the real API, with two simulated devices running the official
 * libsignal. Proves: sender plaintext -> Signal encryption -> ciphertext -> backend/realtime ->
 * receiver -> Signal decryption -> original plaintext, and that the backend never sees plaintext.
 */
const ALICE = '+919876543210';
const BOB = '+919812345678';

let ctx;
let alice;
let bob;
/** Every API response body seen in a test, for leak scanning. */
let responses;

async function makeDevice(phone) {
  const session = await login(ctx, phone, newDevice());
  return new SignalTestDevice({
    app: ctx.app,
    auth: {
      userId: session.user.id,
      deviceId: session.device.deviceId,
      accessToken: session.tokens.accessToken,
    },
  });
}

const track = (res) => {
  responses.push(JSON.stringify(res.body ?? null));
  return res;
};

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  ctx = buildTestApp();
  await ctx.redis.flushall();
  responses = [];
  alice = await makeDevice(ALICE);
  bob = await makeDevice(BOB);
  expect(track((await alice.registerKeys()).res).status).toBe(200);
  expect(track((await bob.registerKeys()).res).status).toBe(200);
});

const peer = (device) => ({ userId: device.auth.userId, deviceId: device.auth.deviceId });

describe('E2EE message flow (libsignal, two devices)', () => {
  it('delivers plaintext only to the recipient; the backend stores and relays ciphertext', async () => {
    const plaintext = 'Hello Bob 👋 — this is end-to-end encrypted';

    // 1. Sender encrypts locally (session from Bob's pre-key bundle) and posts ciphertext.
    const sent = await alice.sendText(peer(bob), plaintext);
    track(sent.res);
    track(sent.bundleRes);
    expect(sent.res.status).toBe(201);
    expect(sent.body.type).toBe(3); // PreKeySignalMessage: first message of a new session
    expect(sent.body.ciphertext).not.toContain('Hello');

    // 2. Realtime event goes to Bob's private device channel, carrying ciphertext only.
    expect(ctx.realtime.published).toHaveLength(1);
    const event = ctx.realtime.published[0];
    expect(event.channel).toBe(`${CHANNEL_PREFIX.DEVICE}${bob.auth.deviceId}`);
    expect(event.event).toBe('envelope');
    expect(event.payload.inline).toBe(true);
    expect(event.payload.envelope.ciphertext).toBe(sent.body.ciphertext);
    // Lets the receiver reply on the same session without fetching a new bundle.
    expect(event.payload.envelope.senderDeviceId).toBe(alice.auth.deviceId);
    expect(JSON.stringify(event)).not.toContain(plaintext);

    // 3. Receiver decrypts the realtime envelope...
    expect(await bob.decrypt(event.payload.envelope)).toBe(plaintext);

    // 4. ...and the same envelope is durable in MongoDB for sync (ciphertext only).
    const synced = track(await bob.fetchEnvelopes());
    expect(synced.body.envelopes).toHaveLength(1);
    expect(synced.body.envelopes[0].ciphertext).toBe(sent.body.ciphertext);

    const db = await dumpDatabase();
    expect(db).not.toContain(plaintext);
    expect(db).not.toContain(Buffer.from(plaintext).toString('base64'));
  });

  it('continues the ratchet in both directions with SignalMessages', async () => {
    const first = await alice.sendText(peer(bob), 'one');
    expect(await bob.decrypt(ctx.realtime.published[0].payload.envelope)).toBe('one');

    const reply = await bob.sendText(peer(alice), 'two');
    expect(reply.res.status).toBe(201);
    expect(reply.body.type).toBe(2); // Bob already has the session: SignalMessage
    expect(await alice.decrypt(ctx.realtime.published[1].payload.envelope)).toBe('two');

    const third = await alice.sendText(peer(bob), 'three');
    expect(third.body.type).toBe(2);
    expect(await bob.decrypt(ctx.realtime.published[2].payload.envelope)).toBe('three');
    expect(first.res.status).toBe(201);
  });

  it('keeps working after both devices restart (session state restored from storage)', async () => {
    await alice.sendText(peer(bob), 'before restart');
    await bob.decrypt(ctx.realtime.published[0].payload.envelope);

    // Simulated force-close: only persisted state survives.
    const aliceAfter = new SignalTestDevice({
      app: ctx.app,
      auth: alice.auth,
      state: SignalTestDevice.importState(alice.exportState()),
    });
    const bobAfter = new SignalTestDevice({
      app: ctx.app,
      auth: bob.auth,
      state: SignalTestDevice.importState(bob.exportState()),
    });

    const sent = await aliceAfter.sendText(peer(bob), 'after restart');
    expect(sent.bundleRes).toBeNull(); // existing session reused, no new bundle fetch
    expect(await bobAfter.decrypt(ctx.realtime.published[1].payload.envelope)).toBe(
      'after restart',
    );
  });

  it('falls back to an id-only realtime event when the envelope exceeds the inline limit', async () => {
    const large = 'x'.repeat(LIMITS.PUSHER_INLINE_PAYLOAD_BYTES);
    const sent = await alice.sendText(peer(bob), large);
    expect(sent.res.status).toBe(201);

    const event = ctx.realtime.published[0];
    expect(event.payload).toEqual({
      envelopeId: expect.any(String),
      seq: sent.res.body.seq,
      inline: false,
    });
    expect(JSON.stringify(event.payload).length).toBeLessThan(200);

    // Receiver fetches it over HTTPS and decrypts.
    const synced = await bob.fetchEnvelopes();
    expect(await bob.decrypt(synced.body.envelopes[0])).toBe(large);
  });

  it('never exposes private keys in requests, responses, realtime payloads or MongoDB', async () => {
    const sent = await alice.sendText(peer(bob), 'secret check');
    track(sent.res);
    track(sent.bundleRes);
    track(await bob.fetchEnvelopes());
    track(await request(ctx.app).get('/keys/status').set(bearer(alice.auth.accessToken)));
    track(await request(ctx.app).get('/devices').set(bearer(alice.auth.accessToken)));

    const secrets = [...alice.privateKeyMaterial(), ...bob.privateKeyMaterial()];
    expect(secrets.length).toBeGreaterThan(10);

    const haystacks = {
      responses: responses.join('\n'),
      realtime: JSON.stringify(ctx.realtime.published),
      database: await dumpDatabase(),
      logs: JSON.stringify(ctx.lines),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const secret of secrets) {
        expect(text.includes(secret), `private key found in ${where}`).toBe(false);
      }
    }
  });
});

describe('message API', () => {
  it('is idempotent on clientMessageId (crash/retry safe)', async () => {
    const clientMessageId = '3b241101-e2bb-4255-8caf-4136c566a962';
    const first = await alice.sendText(peer(bob), 'once', { clientMessageId });
    const retry = await request(ctx.app)
      .post('/messages')
      .set(bearer(alice.auth.accessToken))
      .send(first.body);

    expect(first.res.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ messageId: first.res.body.messageId, duplicate: true });
    expect((await bob.fetchEnvelopes()).body.envelopes).toHaveLength(1);
  });

  it('rejects plaintext-shaped or unexpected fields', async () => {
    const res = await request(ctx.app)
      .post('/messages')
      .set(bearer(alice.auth.accessToken))
      .send({
        recipientUserId: bob.auth.userId,
        recipientDeviceId: bob.auth.deviceId,
        clientMessageId: '3b241101-e2bb-4255-8caf-4136c566a962',
        type: 3,
        ciphertext: Buffer.from('abc').toString('base64'),
        text: 'plaintext must never be accepted',
      });
    expect(res.status).toBe(400);
  });

  it('only returns and acknowledges the caller’s own envelopes', async () => {
    await alice.sendText(peer(bob), 'for bob');

    expect((await alice.fetchEnvelopes()).body.envelopes).toHaveLength(0);
    const bobs = (await bob.fetchEnvelopes()).body.envelopes;
    expect(bobs).toHaveLength(1);

    const ack = await request(ctx.app)
      .post('/messages/envelopes/ack')
      .set(bearer(bob.auth.accessToken))
      .send({ upToSeq: bobs[0].seq });
    expect(ack.body.acknowledged).toBe(1);
    expect((await bob.fetchEnvelopes()).body.envelopes).toHaveLength(0);
  });

  it('assigns increasing per-device sequence numbers for sync', async () => {
    const a = await alice.sendText(peer(bob), 'a');
    const b = await alice.sendText(peer(bob), 'b');
    expect(b.res.body.seq).toBe(a.res.body.seq + 1);

    const after = await bob.fetchEnvelopes(a.res.body.seq);
    expect(after.body.envelopes.map((e) => e.seq)).toEqual([b.res.body.seq]);
  });

  it('tells the sender to refetch keys when the recipient device changed', async () => {
    await alice.sendText(peer(bob), 'hello');
    await clearCooldowns(ctx.redis);
    await login(ctx, BOB, newDevice()); // Bob moves to a new install; old device is revoked

    const res = await alice.sendText(peer(bob), 'still there?');
    expect(res.res.status).toBe(409);
    expect(res.res.body.error.code).toBe('STALE_RECIPIENT_DEVICE');
  });

  it('requires authentication and registered keys', async () => {
    await request(ctx.app).get('/messages/envelopes').expect(401);
    await Device.updateOne({ deviceId: alice.auth.deviceId }, { $set: { signal: null } });
    const res = await alice.sendText(peer(bob), 'no keys');
    expect(res.res.status).toBe(409);
    expect(res.res.body.error.code).toBe('KEYS_NOT_REGISTERED');
  });
});
