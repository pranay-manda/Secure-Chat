import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config/env.js';
import {
  bearer,
  buildTestApp,
  connectTestDb,
  disconnectTestDb,
  login,
  newDevice,
  resetTestDb,
  TEST_ENV,
} from './helpers.js';
import { SignalTestDevice } from './signalTestDevice.js';

/**
 * Online status: a Redis key renewed by heartbeats from an authenticated device and forgotten
 * after a TTL; visible only to people you have a conversation with; cleared by every sign-out
 * path. Nothing is written to MongoDB.
 */
const ALICE = '+919876543210';
const BOB = '+919812345678';
const CAROL = '+919811100000';

let ctx;
let alice;
let bob;
let carol;

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
  await device.registerKeys();
  return {
    id: session.user.id,
    deviceId: session.device.deviceId,
    token: session.tokens.accessToken,
    device,
  };
}

const api = (user) => ({
  get: (path) => request(ctx.app).get(path).set(bearer(user.token)),
  post: (path, body) => request(ctx.app).post(path).set(bearer(user.token)).send(body),
  delete: (path) => request(ctx.app).delete(path).set(bearer(user.token)),
});
const beat = (user) => api(user).post('/presence/heartbeat').expect(204);
const seen = async (viewer, ...users) => {
  const res = await api(viewer).get(`/presence?userIds=${users.map((u) => u.id).join(',')}`);
  expect(res.status).toBe(200);
  return res.body.presence;
};

async function setup(env = {}) {
  ctx = buildTestApp({ env });
  await ctx.redis.flushall();
  alice = await makeUser(ALICE);
  bob = await makeUser(BOB);
  carol = await makeUser(CAROL);
  // Alice and Bob have a conversation; Carol talks to nobody.
  await alice.device.sendText({ userId: bob.id, deviceId: bob.deviceId }, 'hello');
}

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  await setup();
});

describe('online status', () => {
  it('a heartbeat makes a user online for people they chat with, and only for them', async () => {
    expect(await seen(alice, bob)).toEqual({ [bob.id]: false });
    await beat(bob);
    expect(await seen(alice, bob)).toEqual({ [bob.id]: true });
    // Carol has no conversation with Bob: she reads him as offline, like a stranger.
    expect(await seen(carol, bob)).toEqual({ [bob.id]: false });
    // Unknown ids and your own id read as offline too; no error reveals whether they exist.
    const unknown = '507f1f77bcf86cd799439011';
    expect(await seen(alice, { id: unknown }, bob, alice)).toEqual({
      [unknown]: false,
      [bob.id]: true,
      [alice.id]: false,
    });
    // Only a boolean: no last-seen time, no device, no session.
    const res = await api(alice).get(`/presence?userIds=${bob.id}`);
    expect(res.body).toEqual({ presence: { [bob.id]: true } });
  });

  it('pushes changes to chat partners only: online on the first beat, offline on going away', async () => {
    const presenceEvents = () =>
      ctx.realtime.published
        .filter((e) => e.event === 'presence')
        .map((e) => ({ to: e.channel, ...e.payload }));
    ctx.realtime.published.length = 0;

    await beat(bob);
    await beat(bob); // still online: nothing new to tell
    expect(presenceEvents()).toEqual([
      { to: `private-device-${alice.deviceId}`, userId: bob.id, online: true },
    ]);

    await api(bob).delete('/presence').expect(204);
    await api(bob).delete('/presence').expect(204); // already away: no second event
    expect(presenceEvents()).toEqual([
      { to: `private-device-${alice.deviceId}`, userId: bob.id, online: true },
      { to: `private-device-${alice.deviceId}`, userId: bob.id, online: false },
    ]);

    // Carol talks to nobody: her status reaches no one, and she never hears about Bob.
    await beat(carol);
    const all = presenceEvents();
    expect(all.filter((e) => e.userId === carol.id)).toEqual([]);
    expect(all.filter((e) => e.to.endsWith(carol.deviceId))).toEqual([]);
    // Only the user id and a boolean.
    for (const e of ctx.realtime.published.filter((x) => x.event === 'presence')) {
      expect(Object.keys(e.payload).sort()).toEqual(['online', 'userId']);
    }
  });

  it('is kept in Redis only, with the configured TTL, never in MongoDB', async () => {
    await beat(bob);
    const ttl = await ctx.redis.pttl(`presence:${bob.id}`);
    expect(ttl).toBeGreaterThan(40_000);
    expect(ttl).toBeLessThanOrEqual(45_000);
    expect(await ctx.redis.get(`presence:${bob.id}`)).toBe(bob.deviceId);
    const { User } = await import('../src/models/User.js');
    const user = await User.findById(bob.id).lean();
    expect(user.lastSeen).toBeNull();
    expect(JSON.stringify(user)).not.toMatch(/online|presence|heartbeat/i);
  });

  it('expires after the TTL without a heartbeat; a new beat renews it', async () => {
    await setup({ PRESENCE_TTL_SECONDS: '5' });
    await beat(bob);
    expect(await seen(alice, bob)).toEqual({ [bob.id]: true });
    await ctx.redis.pexpire(`presence:${bob.id}`, 1); // the TTL ran out
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await seen(alice, bob)).toEqual({ [bob.id]: false });
    await beat(bob);
    expect(await seen(alice, bob)).toEqual({ [bob.id]: true });
    expect(await ctx.redis.pttl(`presence:${bob.id}`)).toBeGreaterThan(4_000);
  });

  it('the device going away (DELETE) clears it; a stale device cannot clear a newer one', async () => {
    await beat(bob);
    await api(bob).delete('/presence').expect(204);
    expect(await seen(alice, bob)).toEqual({ [bob.id]: false });

    // Bob signs in on a new phone: the old phone's session is over, its beats are refused and
    // its "going away" cannot touch the new phone's status.
    await beat(bob);
    await ctx.redis.del(...(await ctx.redis.keys('otp*'))); // OTP resend cooldown
    const newPhone = await login(ctx, BOB, newDevice());
    const bob2 = {
      id: bob.id,
      deviceId: newPhone.device.deviceId,
      token: newPhone.tokens.accessToken,
    };
    expect(await seen(alice, bob)).toEqual({ [bob.id]: false }); // signing in elsewhere cleared it
    await beat(bob2);
    expect((await api(bob).post('/presence/heartbeat')).status).toBe(401); // stale session
    expect((await api(bob).delete('/presence')).status).toBe(401);
    expect(await seen(alice, bob)).toEqual({ [bob.id]: true });
  });

  it('logout, device revocation and account deletion clear it', async () => {
    await beat(bob);
    await api(bob).post('/auth/logout').expect(204);
    expect(await seen(alice, bob)).toEqual({ [bob.id]: false });

    await beat(alice);
    expect(await ctx.redis.exists(`presence:${alice.id}`)).toBe(1);
    await api(alice).delete(`/devices/${alice.deviceId}`).expect(204);
    expect(await ctx.redis.exists(`presence:${alice.id}`)).toBe(0);

    await beat(carol);
    await api(carol).delete('/account').expect(204);
    expect(await ctx.redis.exists(`presence:${carol.id}`)).toBe(0);
  });

  it('validates and limits requests', async () => {
    expect((await request(ctx.app).post('/presence/heartbeat')).status).toBe(401);
    expect((await request(ctx.app).get(`/presence?userIds=${bob.id}`)).status).toBe(401);
    expect((await api(alice).get('/presence')).status).toBe(400);
    expect((await api(alice).get('/presence?userIds=not-an-id')).status).toBe(400);
    const many = Array.from({ length: 51 }, () => '507f1f77bcf86cd799439011').join(',');
    expect((await api(alice).get(`/presence?userIds=${many}`)).status).toBe(400);
    expect((await api(alice).post('/presence/heartbeat', { userId: bob.id })).status).toBe(204);
    expect(await ctx.redis.get(`presence:${bob.id}`)).toBeNull(); // body ignored: own id only

    for (let i = 0; i < 12; i += 1) await beat(carol); // one per 20 s, plus a few extra
    expect((await api(carol).post('/presence/heartbeat')).status).toBe(429);
  });

  it('config: the TTL is bounded', () => {
    expect(() => loadEnv({ ...TEST_ENV, PRESENCE_TTL_SECONDS: '2' })).toThrow(/PRESENCE_TTL/);
    expect(() => loadEnv({ ...TEST_ENV, PRESENCE_TTL_SECONDS: '601' })).toThrow(/PRESENCE_TTL/);
    expect(loadEnv({ ...TEST_ENV }).presence.ttlSeconds).toBe(45);
  });
});
