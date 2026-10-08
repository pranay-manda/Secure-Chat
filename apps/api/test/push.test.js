import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Device } from '../src/models/Device.js';
import { Session } from '../src/models/Session.js';
import { createPushProvider } from '../src/services/push/index.js';
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
const TOKEN = 'ExponentPushToken[bobDeviceToken_0123456789]';

let ctx;
let alice;
let bob;
let pushes;
let pushResult;

function fakePushProvider() {
  return {
    send: vi.fn(async (message) => {
      pushes.push(JSON.parse(JSON.stringify(message)));
      if (pushResult instanceof Error) throw pushResult;
      return pushResult;
    }),
  };
}

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
  await device.registerKeys();
  return device;
}

const peer = (device) => ({ userId: device.auth.userId, deviceId: device.auth.deviceId });
const setToken = (device, token = TOKEN) =>
  request(ctx.app).post('/devices/push-token').set(bearer(device.auth.accessToken)).send({ token });
const storedToken = async (device) =>
  (await Device.findOne({ deviceId: device.auth.deviceId }).lean()).pushToken?.token ?? null;

async function setup(env = {}) {
  ctx = buildTestApp({ env, pushProvider: fakePushProvider() });
  await ctx.redis.flushall();
  alice = await makeDevice(ALICE);
  bob = await makeDevice(BOB);
}

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  pushes = [];
  pushResult = { ok: true };
  await setup({ PUSH_NOTIFY_DELAY_MS: '0' });
});

describe('POST /devices/push-token', () => {
  it('stores the token on the calling device only, and never returns it', async () => {
    await setToken(bob).expect(204);

    expect(await storedToken(bob)).toBe(TOKEN);
    expect(await storedToken(alice)).toBeNull();
    const list = await request(ctx.app).get('/devices').set(bearer(bob.auth.accessToken));
    expect(JSON.stringify(list.body)).not.toContain(TOKEN);
  });

  it('replaces the token on refresh (one token per device, no duplicates)', async () => {
    await setToken(bob).expect(204);
    await setToken(bob).expect(204); // same token again: idempotent
    const refreshed = 'ExponentPushToken[bobRefreshedToken_987654]';
    await setToken(bob, refreshed).expect(204);

    expect(await storedToken(bob)).toBe(refreshed);
    expect(await Device.countDocuments({ 'pushToken.token': TOKEN })).toBe(0);
  });

  it('moves a token that was registered by another device', async () => {
    await setToken(alice).expect(204);
    await setToken(bob).expect(204);

    expect(await storedToken(alice)).toBeNull();
    expect(await storedToken(bob)).toBe(TOKEN);
  });

  it('validates the token and requires authentication', async () => {
    for (const token of ['', 'not-a-token', 'ExponentPushToken[]', 42, 'ExponentPushToken[a b]']) {
      expect((await setToken(bob, token)).status).toBe(400);
    }
    await request(ctx.app).post('/devices/push-token').send({ token: TOKEN }).expect(401);
  });

  it('DELETE clears it; logout clears it; a new login on another device clears the old one', async () => {
    await setToken(bob).expect(204);
    await request(ctx.app)
      .delete('/devices/push-token')
      .set(bearer(bob.auth.accessToken))
      .expect(204);
    expect(await storedToken(bob)).toBeNull();

    await setToken(bob).expect(204);
    await request(ctx.app).post('/auth/logout').set(bearer(bob.auth.accessToken)).expect(204);
    expect(await storedToken(bob)).toBeNull();

    await setToken(alice).expect(204);
    await clearCooldowns(ctx.redis);
    await login(ctx, ALICE, newDevice()); // Alice moves to a new install
    expect(await storedToken(alice)).toBeNull();
  });
});

describe('push notifications for new messages', () => {
  it('notifies an unreachable device with an opaque payload only', async () => {
    await setToken(bob).expect(204);
    const text = 'Hello Bob, top secret';

    const sent = await alice.sendText(peer(bob), text);
    await ctx.container.pushNotifier.idle();

    expect(pushes).toEqual([
      {
        to: TOKEN,
        title: 'Secure Chat',
        body: 'New message',
        data: { type: 'new_message', messageId: sent.res.body.messageId, hasMessage: true },
        channelId: 'messages',
        priority: 'high',
        sound: 'default',
      },
    ]);
    const payload = JSON.stringify(pushes);
    for (const secret of [
      text,
      Buffer.from(text).toString('base64'),
      sent.body.ciphertext,
      alice.auth.userId,
      alice.auth.deviceId,
      ALICE,
      sent.res.body.conversationId,
      ...alice.privateKeyMaterial(),
      ...bob.privateKeyMaterial(),
    ]) {
      expect(payload.includes(secret)).toBe(false);
    }
    // Push tokens are never logged.
    expect(JSON.stringify(ctx.lines)).not.toContain(TOKEN);
  });

  it('does not notify when the device acknowledged over realtime in time (no duplicates)', async () => {
    await setup({ PUSH_NOTIFY_DELAY_MS: '300' });
    await setToken(bob).expect(204);

    await alice.sendText(peer(bob), 'seen live');
    // Bob's open app got the Pusher event, decrypted and acked immediately.
    const envelopes = (await bob.fetchEnvelopes()).body.envelopes;
    await request(ctx.app)
      .post('/messages/envelopes/ack')
      .set(bearer(bob.auth.accessToken))
      .send({ upToSeq: envelopes.at(-1).seq })
      .expect(200);
    await ctx.container.pushNotifier.idle();

    expect(pushes).toEqual([]);
  });

  it('does not notify devices without a token, signed-out devices or duplicate sends', async () => {
    const first = await alice.sendText(peer(bob), 'no token yet');
    await ctx.container.pushNotifier.idle();
    expect(pushes).toEqual([]);

    await setToken(bob).expect(204);
    await request(ctx.app).post('/messages').set(bearer(alice.auth.accessToken)).send(first.body);
    await ctx.container.pushNotifier.idle();
    expect(pushes).toEqual([]); // a retry of an existing message never re-notifies

    await Device.updateOne(
      { deviceId: bob.auth.deviceId },
      { $set: { pushToken: { token: TOKEN } } },
    );
    await Session.updateMany({ deviceId: bob.auth.deviceId }, { $set: { revokedAt: new Date() } });
    await alice.sendText(peer(bob), 'signed out');
    await ctx.container.pushNotifier.idle();
    expect(pushes).toEqual([]);
  });

  it('drops a token the push service reports as no longer registered', async () => {
    await setToken(bob).expect(204);
    pushResult = { ok: false, error: 'DeviceNotRegistered' };

    await alice.sendText(peer(bob), 'uninstalled?');
    await ctx.container.pushNotifier.idle();

    expect(pushes).toHaveLength(1);
    expect(await storedToken(bob)).toBeNull();
  });

  it('a push failure never affects the message', async () => {
    await setToken(bob).expect(204);
    pushResult = new Error('FCM unavailable');

    const sent = await alice.sendText(peer(bob), 'still delivered');
    await ctx.container.pushNotifier.idle();

    expect(sent.res.status).toBe(201);
    expect(ctx.lines.some((l) => /Push notification failed/.test(l.msg))).toBe(true);
    const envelopes = (await bob.fetchEnvelopes()).body.envelopes;
    expect(await bob.decrypt(envelopes[0])).toBe('still delivered');
  });
});

describe('Expo push provider', () => {
  const message = { to: TOKEN, title: 'Secure Chat', body: 'New message', data: {} };

  it('posts the message to the Expo push API', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ status: 'ok', id: 'ticket' }] }),
    }));
    const provider = createPushProvider(
      { provider: 'expo', accessToken: 'expo-access-token-0123456789' },
      { fetchImpl },
    );

    expect(await provider.send(message)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(init.headers.Authorization).toBe('Bearer expo-access-token-0123456789');
    expect(JSON.parse(init.body)).toEqual([message]);
  });

  it('maps ticket errors and throws on HTTP/network failure without leaking the token', async () => {
    const ticketError = createPushProvider(
      { provider: 'expo' },
      {
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            data: [
              {
                status: 'error',
                message: `${TOKEN} is not registered`,
                details: { error: 'DeviceNotRegistered' },
              },
            ],
          }),
        }),
      },
    );
    expect(await ticketError.send(message)).toEqual({ ok: false, error: 'DeviceNotRegistered' });

    const httpError = createPushProvider(
      { provider: 'expo' },
      { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) },
    );
    await expect(httpError.send(message)).rejects.toThrow('Push service HTTP 503');

    const network = createPushProvider(
      { provider: 'expo' },
      {
        fetchImpl: async () => {
          throw new Error(`connect failed for ${TOKEN}`);
        },
      },
    );
    const err = await network.send(message).catch((e) => e);
    expect(err.message).not.toContain(TOKEN);
    expect(createPushProvider({ provider: 'none' })).toBeNull();
  });
});
