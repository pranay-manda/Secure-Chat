import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Counter } from '../src/models/Counter.js';
import { Device } from '../src/models/Device.js';
import { Message } from '../src/models/Message.js';
import { MessageEnvelope } from '../src/models/MessageEnvelope.js';
import { OneTimePreKey } from '../src/models/OneTimePreKey.js';
import { Session } from '../src/models/Session.js';
import { User } from '../src/models/User.js';
import {
  bearer,
  buildTestApp,
  connectTestDb,
  disconnectTestDb,
  login,
  newDevice,
  resetTestDb,
} from './helpers.js';
import { SignalTestDevice } from './signalTestDevice.js';

/** DELETE /account: the signed-in user permanently deletes their own account. */
const ALICE = '+919876543210';
const BOB = '+919812345678';
const PUSH_TOKEN = 'ExponentPushToken[aliceDeviceToken_0123456789]';

let ctx;
let alice;
let bob;

async function makeUser(phone) {
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
  return { ...session, device };
}

const as = (user) => ({
  get: (path) => request(ctx.app).get(path).set(bearer(user.tokens.accessToken)),
  post: (path, body) => request(ctx.app).post(path).set(bearer(user.tokens.accessToken)).send(body),
  delete: (path) => request(ctx.app).delete(path).set(bearer(user.tokens.accessToken)),
});
const peer = (user) => ({ userId: user.user.id, deviceId: user.device.auth.deviceId });

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  ctx = buildTestApp();
  await ctx.redis.flushall();
  alice = await makeUser(ALICE);
  bob = await makeUser(BOB);
  await as(alice).post('/devices/push-token', { token: PUSH_TOKEN }).expect(204);
  // Messages both ways, so Alice has inbox ciphertext, sent ciphertext and metadata.
  await bob.device.sendText(peer(alice), 'hi Alice');
  await alice.device.sendText(peer(bob), 'hi Bob');
});

describe('DELETE /account', () => {
  it('deletes the account and everything that belongs to it, in one go', async () => {
    const aliceId = alice.user.id;
    const aliceDevice = alice.device.auth.deviceId;
    const toAlice = await MessageEnvelope.findOne({ recipientUserId: aliceId }).lean();
    expect(toAlice).not.toBeNull();

    const res = await as(alice).delete('/account');

    expect(res.status).toBe(204);
    expect(await User.exists({ _id: aliceId })).toBeNull();
    expect(await Session.countDocuments({ userId: aliceId })).toBe(0);
    expect(await Device.countDocuments({ userId: aliceId })).toBe(0); // push token + public keys
    expect(await Device.countDocuments({ 'pushToken.token': PUSH_TOKEN })).toBe(0);
    expect(await OneTimePreKey.countDocuments({ userId: aliceId })).toBe(0);
    expect(await MessageEnvelope.countDocuments({ recipientUserId: aliceId })).toBe(0);
    expect(
      await Message.countDocuments({
        $or: [{ senderUserId: aliceId }, { recipientUserId: aliceId }],
      }),
    ).toBe(0);
    expect(await Counter.exists({ _id: `envelope:${aliceDevice}` })).toBeNull();

    // Bob is untouched, and still receives what Alice sent before deleting her account.
    expect(await User.exists({ _id: bob.user.id })).not.toBeNull();
    expect(await Device.countDocuments({ userId: bob.user.id, revokedAt: null })).toBe(1);
    const inbox = await as(bob).get('/messages/envelopes?after=0');
    expect(inbox.body.envelopes).toHaveLength(1);
    expect(await bob.device.decrypt(inbox.body.envelopes[0])).toBe('hi Bob');
  });

  it('ends every session at once: access token, refresh token and device access stop working', async () => {
    // A second session for Alice on another device would be revoked by login; use refresh.
    await as(alice).delete('/account').expect(204);

    for (const path of [
      '/devices',
      '/keys/status',
      '/messages/envelopes?after=0',
      '/pusher/config',
    ]) {
      expect((await as(alice).get(path)).status).toBe(401);
    }
    const refreshed = await request(ctx.app)
      .post('/auth/refresh')
      .send({ refreshToken: alice.tokens.refreshToken, deviceId: alice.device.auth.deviceId });
    expect(refreshed.status).toBe(401);
    // Her keys are gone: nobody can start a new session with the deleted account.
    expect((await as(bob).get(`/keys/bundle/${alice.user.id}`)).status).toBe(404);
    // Messages to her are refused (nothing is stored for a deleted account).
    const send = await as(bob).post('/messages', {
      recipientUserId: alice.user.id,
      recipientDeviceId: alice.device.auth.deviceId,
      clientMessageId: randomUUID(),
      type: 2,
      ciphertext: Buffer.from('opaque').toString('base64'),
    });
    expect(send.status).toBe(409);
  });

  it('requires authentication', async () => {
    for (const auth of [null, 'Bearer not.a.token']) {
      const req = request(ctx.app).delete('/account');
      const res = await (auth ? req.set('Authorization', auth) : req);
      expect(res.status).toBe(401);
    }
    expect(await User.countDocuments()).toBe(2);
  });

  it('only ever deletes the caller: no way to name another account', async () => {
    // Bob tries every way of pointing the request at Alice.
    const attempts = [
      request(ctx.app).delete(`/account/${alice.user.id}`),
      request(ctx.app).delete(`/account?userId=${alice.user.id}`),
      request(ctx.app).delete('/account').send({ userId: alice.user.id }),
    ];
    for (const attempt of attempts) await attempt.set(bearer(bob.tokens.accessToken));

    // The path variant is not a route; the others delete Bob (the caller), never Alice.
    expect(await User.exists({ _id: alice.user.id })).not.toBeNull();
    expect(await Device.countDocuments({ userId: alice.user.id })).toBe(1);
    expect(await Session.countDocuments({ userId: alice.user.id, revokedAt: null })).toBe(1);
    expect((await as(alice).get('/devices')).status).toBe(200);
  });

  it('a repeated or concurrent deletion is harmless', async () => {
    const [first, second] = await Promise.all([
      as(alice).delete('/account'),
      as(alice).delete('/account'),
    ]);
    expect([first.status, second.status].sort()).toEqual(
      first.status === 204 && second.status === 204 ? [204, 204] : [204, 401],
    );
    const again = await as(alice).delete('/account');
    expect(again.status).toBe(401); // the session is gone; nothing else happens
    expect(await User.countDocuments()).toBe(1);
    expect(JSON.stringify(ctx.lines.filter((l) => l.msg === 'Account deleted'))).not.toMatch(
      /\+91|phone|email/i,
    );
    expect(ctx.lines.filter((l) => l.msg === 'Account deleted')).toHaveLength(1);
  });

  it('the same phone number can sign up again afterwards, as a brand-new account', async () => {
    await as(alice).delete('/account').expect(204);
    await ctx.redis.flushall(); // OTP resend cooldown
    const again = await login(ctx, ALICE, newDevice());
    expect(again.user.id).not.toBe(alice.user.id);
    expect(again.user.isNew).toBe(true);
  });
});
