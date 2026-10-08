import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OneTimePreKey } from '../src/models/OneTimePreKey.js';
import {
  bearer,
  buildTestApp,
  clearCooldowns,
  connectTestDb,
  disconnectTestDb,
  login,
  newDevice,
  resetTestDb,
} from './helpers.js';
import { SignalTestDevice } from './signalTestDevice.js';

const ALICE = '+919876543210';
const BOB = '+919812345678';

let ctx;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  ctx = buildTestApp();
  await ctx.redis.flushall();
});

async function makeDevice(phone, device = newDevice()) {
  const session = await login(ctx, phone, device);
  return new SignalTestDevice({
    app: ctx.app,
    auth: {
      userId: session.user.id,
      deviceId: session.device.deviceId,
      accessToken: session.tokens.accessToken,
    },
  });
}

describe('PUT /keys', () => {
  it('registers public keys and reports status', async () => {
    const alice = await makeDevice(ALICE);
    const { res, body } = await alice.registerKeys({ oneTimeCount: 7 });

    expect(res.status).toBe(200);
    expect(res.body.status).toEqual({
      registered: true,
      registrationId: body.registrationId,
      signedPreKeyId: body.signedPreKey.keyId,
      kyberPreKeyId: body.kyberPreKey.keyId,
      oneTimePreKeyCount: 7,
    });
  });

  it('rejects unknown fields such as a private key', async () => {
    const alice = await makeDevice(ALICE);
    const { body } = await alice.registerKeys();
    const res = await request(ctx.app)
      .put('/keys')
      .set(bearer(alice.auth.accessToken))
      .send({ ...body, oneTimePreKeys: [], identityPrivateKey: body.identityKey });
    expect(res.status).toBe(400);
  });

  it('rejects malformed key material', async () => {
    const alice = await makeDevice(ALICE);
    const { body } = await alice.registerKeys();
    const bad = [
      { ...body, identityKey: 'AAAA' },
      { ...body, signedPreKey: { ...body.signedPreKey, signature: 'AAAA' } },
      { ...body, kyberPreKey: { ...body.kyberPreKey, publicKey: body.identityKey } },
      { ...body, registrationId: 0 },
    ];
    for (const payload of bad) {
      const res = await request(ctx.app)
        .put('/keys')
        .set(bearer(alice.auth.accessToken))
        .send({ ...payload, oneTimePreKeys: [] });
      expect(res.status).toBe(400);
    }
  });

  it('refuses to replace a registered identity key (token theft cannot swap keys)', async () => {
    const alice = await makeDevice(ALICE);
    await alice.registerKeys();
    const impostor = new SignalTestDevice({ app: ctx.app, auth: alice.auth });

    const { res } = await impostor.registerKeys({ oneTimeCount: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDENTITY_KEY_CONFLICT');
  });

  it('a fresh OTP login on the same install allows new keys', async () => {
    const device = newDevice();
    const alice = await makeDevice(ALICE, device);
    await alice.registerKeys();
    await clearCooldowns(ctx.redis);
    const again = await makeDevice(ALICE, device);

    const { res } = await again.registerKeys();
    expect(res.status).toBe(200);
  });

  it('requires authentication', async () => {
    await request(ctx.app).put('/keys').send({}).expect(401);
    await request(ctx.app).get('/keys/status').expect(401);
  });
});

describe('POST /keys/one-time', () => {
  it('adds pre-keys up to the cap', async () => {
    const alice = await makeDevice(ALICE);
    const { body } = await alice.registerKeys({ oneTimeCount: 0 });
    const keyBatch = (start) =>
      Array.from({ length: 100 }, (_, i) => ({
        keyId: start + i,
        publicKey: body.identityKey, // any valid 33-byte public key works for the cap test
      }));

    for (const start of [1, 101]) {
      const res = await request(ctx.app)
        .post('/keys/one-time')
        .set(bearer(alice.auth.accessToken))
        .send({ preKeys: keyBatch(start) });
      expect(res.status).toBe(200);
    }
    const over = await request(ctx.app)
      .post('/keys/one-time')
      .set(bearer(alice.auth.accessToken))
      .send({ preKeys: keyBatch(201).slice(0, 1) });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('PREKEY_LIMIT_EXCEEDED');
  });
});

describe('GET /keys/bundle/:userId', () => {
  it('returns public material only and hands out each one-time pre-key once', async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    const { body } = await bob.registerKeys({ oneTimeCount: 2 });

    const first = (await alice.fetchBundle(bob.auth.userId)).body.bundle;
    const second = (await alice.fetchBundle(bob.auth.userId)).body.bundle;
    const third = (await alice.fetchBundle(bob.auth.userId)).body.bundle;

    expect(Object.keys(first).sort()).toEqual(
      [
        'deviceId',
        'identityKey',
        'kyberPreKey',
        'oneTimePreKey',
        'registrationId',
        'signalDeviceId',
        'signedPreKey',
        'userId',
      ].sort(),
    );
    expect(first.identityKey).toBe(body.identityKey);
    expect(first.oneTimePreKey.keyId).not.toBe(second.oneTimePreKey.keyId);
    expect(third.oneTimePreKey).toBeNull(); // pool exhausted: signed + Kyber pre-keys only
    expect(await OneTimePreKey.countDocuments({ deviceId: bob.auth.deviceId })).toBe(0);
  });

  it('establishes a working session even when no one-time pre-key is left', async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    await alice.registerKeys();
    await bob.registerKeys({ oneTimeCount: 0 });

    const sent = await alice.sendText(
      { userId: bob.auth.userId, deviceId: bob.auth.deviceId },
      'no one-time key',
    );
    expect(sent.bundleRes.body.bundle.oneTimePreKey).toBeNull();
    expect(await bob.decrypt(ctx.realtime.published[0].payload.envelope)).toBe('no one-time key');
  });

  it('404s for users without keys and for revoked devices', async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    expect((await alice.fetchBundle(bob.auth.userId)).status).toBe(404);

    await bob.registerKeys();
    await request(ctx.app)
      .delete(`/devices/${bob.auth.deviceId}`)
      .set(bearer(bob.auth.accessToken))
      .expect(204);
    expect((await alice.fetchBundle(bob.auth.userId)).status).toBe(404);
    expect(await OneTimePreKey.countDocuments({ deviceId: bob.auth.deviceId })).toBe(0);
  });

  it('rejects fetching your own bundle and invalid ids', async () => {
    const alice = await makeDevice(ALICE);
    await alice.registerKeys();
    expect((await alice.fetchBundle(alice.auth.userId)).status).toBe(400);
    expect((await alice.fetchBundle('not-an-id')).status).toBe(400);
  });

  it('rate limits bundle fetches (protects the one-time pre-key pool)', async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    await bob.registerKeys({ oneTimeCount: 0 });
    let last;
    for (let i = 0; i < 31; i += 1) last = await alice.fetchBundle(bob.auth.userId);
    expect(last.status).toBe(429);
  });
});
