import { createHmac, randomUUID } from 'node:crypto';

import { CHANNEL_PREFIX } from '@secure-chat/shared/constants';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
 * Voice-call signaling API: the server authorizes every action and relays it to the other
 * participant's own device channel. These tests cover signaling only; real audio and WebRTC
 * connectivity can only be verified on physical devices.
 */
const ALICE = '+919876543210';
const BOB = '+919812345678';
const CAROL = '+919811100000';
const BOB_PUSH = 'ExponentPushToken[bobDeviceToken_0123456789]';
const SDP =
  'v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const TURN_SECRET = 'turn-shared-secret-0123456789abcdefghij';

let ctx;
let pushes;
let alice;
let bob;
let carol;

function fakePushProvider() {
  return {
    send: vi.fn(async (message) => {
      pushes.push(JSON.parse(JSON.stringify(message)));
      return { ok: true };
    }),
  };
}

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
    refreshToken: session.tokens.refreshToken,
    registrationId: device.state.registrationId,
  };
}

const api = (user) => ({
  get: (path) => request(ctx.app).get(path).set(bearer(user.token)),
  post: (path, body) => request(ctx.app).post(path).set(bearer(user.token)).send(body),
  delete: (path) => request(ctx.app).delete(path).set(bearer(user.token)),
});
const callEvents = (user) =>
  ctx.realtime.published
    .filter((p) => p.channel === `${CHANNEL_PREFIX.DEVICE}${user.deviceId}` && p.event === 'call')
    .map((p) => p.payload);
const startCall = async (from, to) => {
  const res = await api(from).post('/calls', { calleeUserId: to.id });
  expect(res.status).toBe(201);
  return res.body.call.callId;
};
const answered = async () => {
  const callId = await startCall(alice, bob);
  expect((await api(bob).post(`/calls/${callId}/accept`)).status).toBe(200);
  return callId;
};

async function setup(env = {}) {
  ctx = buildTestApp({ env, pushProvider: fakePushProvider() });
  await ctx.redis.flushall();
  alice = await makeUser(ALICE);
  bob = await makeUser(BOB);
  carol = await makeUser(CAROL);
  await api(bob).post('/devices/push-token', { token: BOB_PUSH }).expect(204);
  ctx.realtime.published.length = 0;
}

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  pushes = [];
  await setup();
});

describe('starting a call', () => {
  it('rings only the callee’s device, with a generic push, and gives the caller ICE servers', async () => {
    const res = await api(alice).post('/calls', { calleeUserId: bob.id });

    expect(res.status).toBe(201);
    const { call, iceServers } = res.body;
    expect(call).toMatchObject({
      callId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      role: 'caller',
      peerUserId: bob.id,
      status: 'ringing',
    });
    expect(Date.parse(call.ringExpiresAt) - Date.parse(call.createdAt)).toBe(45_000);
    expect(iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]); // no TURN set

    // Exactly one event, on Bob's own device channel, with signaling metadata only.
    expect(ctx.realtime.published).toHaveLength(1);
    const [event] = callEvents(bob);
    expect(Object.keys(event).sort()).toEqual(
      ['callId', 'callerUserId', 'createdAt', 'kind', 'ringExpiresAt', 'type'].sort(),
    );
    expect(event).toMatchObject({
      type: 'invite',
      callId: call.callId,
      callerUserId: alice.id,
      kind: 'voice',
    });
    expect(call.kind).toBe('voice'); // the default: a plain POST /calls is a voice call

    await ctx.container.pushNotifier.idle();
    expect(pushes).toEqual([
      {
        to: BOB_PUSH,
        title: 'CipherChat',
        body: 'Incoming voice call',
        data: { type: 'incoming_call', callId: call.callId },
        channelId: 'calls',
        priority: 'high',
        sound: 'default',
        ttl: 45,
      },
    ]);
    // Nothing about the caller in the push (no id, number, name).
    expect(JSON.stringify(pushes)).not.toContain(alice.id);
    expect(JSON.stringify(pushes)).not.toContain(ALICE);
  });

  it('validates the request: authentication, self-calls, unknown or keyless users', async () => {
    expect((await request(ctx.app).post('/calls').send({ calleeUserId: bob.id })).status).toBe(401);
    expect((await api(alice).post('/calls', { calleeUserId: alice.id })).status).toBe(400);
    const unknown = await api(alice).post('/calls', { calleeUserId: '507f1f77bcf86cd799439011' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('CALLEE_UNAVAILABLE');
    for (const body of [{}, { calleeUserId: 'x' }, { calleeUserId: bob.id, extra: 1 }]) {
      expect((await api(alice).post('/calls', body)).status).toBe(400);
    }
    expect(ctx.realtime.published).toHaveLength(0);
  });

  it('one call at a time per person: busy callee, caller already in a call', async () => {
    const callId = await startCall(alice, bob);

    const busy = await api(carol).post('/calls', { calleeUserId: bob.id });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('CALLEE_BUSY');
    for (const [from, to] of [
      [alice, carol],
      [bob, carol],
    ]) {
      const res = await api(from).post('/calls', { calleeUserId: to.id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_IN_CALL');
    }

    await api(alice).post(`/calls/${callId}/end`, {}).expect(204);
    expect((await api(carol).post('/calls', { calleeUserId: bob.id })).status).toBe(201);
  });

  it('a video call is the same call with kind=video everywhere the phone learns about it', async () => {
    await setup({ CALL_RING_TIMEOUT_SECONDS: '1' });
    const res = await api(alice).post('/calls', { calleeUserId: bob.id, kind: 'video' });
    expect(res.status).toBe(201);
    expect(res.body.call.kind).toBe('video');
    const callId = res.body.call.callId;
    expect(callEvents(bob)[0]).toMatchObject({ type: 'invite', callId, kind: 'video' });
    expect((await api(bob).get('/calls/current')).body.call.kind).toBe('video');
    await ctx.container.pushNotifier.idle();
    expect(pushes[0].body).toBe('Incoming video call');
    expect(JSON.stringify(pushes[0])).not.toContain(alice.id); // still no caller identity

    const accept = await api(bob).post(`/calls/${callId}/accept`);
    expect(accept.body.call.kind).toBe('video');
    // The accepted call's media flags (camera on/off) relay in both directions, nothing more.
    await api(alice).post(`/calls/${callId}/signal`, { kind: 'media', video: false }).expect(204);
    await api(bob).post(`/calls/${callId}/signal`, { kind: 'media', video: true }).expect(204);
    expect(callEvents(bob).at(-1)).toEqual({ type: 'signal', callId, kind: 'media', video: false });
    expect(callEvents(alice).at(-1)).toEqual({
      type: 'signal',
      callId,
      kind: 'media',
      video: true,
    });
    for (const body of [
      { kind: 'media' },
      { kind: 'media', video: 'yes' },
      { kind: 'media', video: true, frame: 'AAAA' },
    ]) {
      expect((await api(alice).post(`/calls/${callId}/signal`, body)).status).toBe(400);
    }
    expect(
      (await api(carol).post(`/calls/${callId}/signal`, { kind: 'media', video: true })).status,
    ).toBe(404);
    await api(alice).post(`/calls/${callId}/end`, {}).expect(204);

    // Unknown kinds are refused; a missed video call is noted as one.
    expect((await api(alice).post('/calls', { calleeUserId: bob.id, kind: 'screen' })).status).toBe(
      400,
    );
    const missed = await api(alice).post('/calls', { calleeUserId: bob.id, kind: 'video' });
    await ctx.container.callService.idle();
    const notes = (await api(bob).get('/calls/missed')).body.missed;
    expect(notes).toEqual([
      expect.objectContaining({ callId: missed.body.call.callId, kind: 'video' }),
    ]);
  });

  it('limits how often a user can start calls', async () => {
    for (let i = 0; i < 10; i += 1) {
      const callId = await startCall(alice, bob);
      await api(alice).post(`/calls/${callId}/end`, {}).expect(204);
    }
    const res = await api(alice).post('/calls', { calleeUserId: bob.id });
    expect(res.status).toBe(429);
  });
});

describe('answering, declining, cancelling, hanging up', () => {
  it('only the rung device can answer; the caller is told; answering twice is harmless', async () => {
    const callId = await startCall(alice, bob);

    expect((await api(alice).post(`/calls/${callId}/accept`)).status).toBe(403);
    expect((await api(carol).post(`/calls/${callId}/accept`)).status).toBe(404);

    const res = await api(bob).post(`/calls/${callId}/accept`);
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({
      role: 'callee',
      peerUserId: alice.id,
      status: 'accepted',
    });
    expect(res.body.iceServers.length).toBeGreaterThan(0);
    expect(callEvents(alice)).toEqual([{ type: 'accepted', callId }]);

    expect((await api(bob).post(`/calls/${callId}/accept`)).status).toBe(200);
    expect(callEvents(alice)).toHaveLength(1); // no duplicate event
  });

  it('declining tells the caller; the call cannot be answered afterwards', async () => {
    const callId = await startCall(alice, bob);
    expect((await api(alice).post(`/calls/${callId}/reject`)).status).toBe(403);

    await api(bob).post(`/calls/${callId}/reject`).expect(204);
    await api(bob).post(`/calls/${callId}/reject`).expect(204); // idempotent

    expect(callEvents(alice)).toEqual([
      { type: 'ended', callId, status: 'rejected', reason: 'rejected' },
    ]);
    const late = await api(bob).post(`/calls/${callId}/accept`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CALL_ENDED');
  });

  it('a callee whose phone cannot take the call is reported as failed, not as declined', async () => {
    const callId = await startCall(alice, bob);
    await api(bob).post(`/calls/${callId}/end`, { reason: 'failed' }).expect(204);
    expect(callEvents(alice).at(-1)).toEqual({
      type: 'ended',
      callId,
      status: 'failed',
      reason: 'failed',
    });
    // They saw it ring and tried to answer: no missed-call note for them.
    expect((await api(bob).get('/calls/missed')).body.missed).toEqual([]);
    expect((await api(alice).get('/calls/current')).body.call).toBeNull();

    // A callee hanging up (not failing) while it still rings is still a decline.
    const second = await startCall(alice, bob);
    await api(bob).post(`/calls/${second}/end`, { reason: 'hangup' }).expect(204);
    expect(callEvents(alice).at(-1)).toMatchObject({ callId: second, status: 'rejected' });
  });

  it('the caller cancelling while it rings stops the ringing on the callee', async () => {
    const callId = await startCall(alice, bob);
    await api(alice).post(`/calls/${callId}/end`, { reason: 'hangup' }).expect(204);

    expect(callEvents(bob).at(-1)).toEqual({
      type: 'ended',
      callId,
      status: 'cancelled',
      reason: 'hangup',
    });
    expect((await api(bob).post(`/calls/${callId}/accept`)).body.error.code).toBe('CALL_ENDED');
    expect((await api(alice).get('/calls/current')).body.call).toBeNull();
    expect((await api(bob).get('/calls/current')).body.call).toBeNull();
  });

  it('either side hangs up after answering; failures are reported as failed; ending twice is a no-op', async () => {
    const callId = await answered();

    await api(bob).post(`/calls/${callId}/end`, { reason: 'connection_lost' }).expect(204);
    expect(callEvents(alice).at(-1)).toEqual({
      type: 'ended',
      callId,
      status: 'failed',
      reason: 'connection_lost',
    });
    const before = ctx.realtime.published.length;
    await api(alice).post(`/calls/${callId}/end`, { reason: 'hangup' }).expect(204);
    expect(ctx.realtime.published.length).toBe(before);
    expect((await api(alice).post(`/calls/${callId}/end`, { reason: 'shout' })).status).toBe(400);
  });

  it('a cancel racing the answer always leaves both people out of the call', async () => {
    for (let round = 0; round < 5; round += 1) {
      const callId = await startCall(alice, bob);
      await Promise.all([
        api(bob).post(`/calls/${callId}/accept`),
        api(alice).post(`/calls/${callId}/end`, { reason: 'hangup' }),
      ]);
      expect((await api(alice).get('/calls/current')).body.call).toBeNull();
      expect((await api(bob).get('/calls/current')).body.call).toBeNull();
    }
  });
});

describe('WebRTC signaling relay', () => {
  it('relays SDP and ICE candidates only between the two devices, in the right direction', async () => {
    const callId = await startCall(alice, bob);
    const early = await api(alice).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: SDP });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('CALL_INVALID_STATE');

    await api(bob).post(`/calls/${callId}/accept`).expect(200);
    await api(alice).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: SDP }).expect(204);
    await api(bob).post(`/calls/${callId}/signal`, { kind: 'answer', sdp: SDP }).expect(204);
    const candidates = [
      {
        candidate: 'candidate:1 1 udp 2122260223 10.0.0.2 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    ];
    await api(alice)
      .post(`/calls/${callId}/signal`, { kind: 'candidates', candidates })
      .expect(204);
    await api(bob).post(`/calls/${callId}/signal`, { kind: 'candidates', candidates }).expect(204);

    expect(callEvents(bob).filter((e) => e.type === 'signal')).toEqual([
      { type: 'signal', callId, kind: 'offer', sdp: SDP },
      { type: 'signal', callId, kind: 'candidates', candidates },
    ]);
    expect(callEvents(alice).filter((e) => e.type === 'signal')).toEqual([
      { type: 'signal', callId, kind: 'answer', sdp: SDP },
      { type: 'signal', callId, kind: 'candidates', candidates },
    ]);
    // Nothing about the call ever reaches the third user's channel.
    expect(callEvents(carol)).toEqual([]);

    // Wrong direction, wrong person.
    expect(
      (await api(bob).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: SDP })).status,
    ).toBe(403);
    expect(
      (await api(alice).post(`/calls/${callId}/signal`, { kind: 'answer', sdp: SDP })).status,
    ).toBe(403);
    expect(
      (await api(carol).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: SDP })).status,
    ).toBe(404);
  });

  it('relays the ICE-restart number of a re-sent offer and its answer', async () => {
    const callId = await answered();
    await api(alice).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: SDP, restart: 1 });
    await api(alice)
      .post(`/calls/${callId}/signal`, { kind: 'offer', sdp: SDP, restart: 2 })
      .expect(204);
    await api(bob)
      .post(`/calls/${callId}/signal`, { kind: 'answer', sdp: SDP, restart: 2 })
      .expect(204);
    expect(callEvents(bob).filter((e) => e.kind === 'offer')).toEqual([
      { type: 'signal', callId, kind: 'offer', sdp: SDP, restart: 1 },
      { type: 'signal', callId, kind: 'offer', sdp: SDP, restart: 2 },
    ]);
    expect(callEvents(alice).filter((e) => e.kind === 'answer')).toEqual([
      { type: 'signal', callId, kind: 'answer', sdp: SDP, restart: 2 },
    ]);
  });

  it('rejects malformed or oversized signaling', async () => {
    const callId = await answered();
    const bad = [
      { kind: 'offer', sdp: 'not sdp at all' },
      { kind: 'offer', sdp: `v=0${'x'.repeat(8000)}` },
      { kind: 'offer', sdp: SDP, audio: 'AAAA' },
      { kind: 'offer', sdp: SDP, restart: 0 },
      { kind: 'offer', sdp: SDP, restart: 1.5 },
      { kind: 'offer', sdp: SDP, restart: '1' },
      { kind: 'offer', sdp: SDP, restart: 1001 },
      { kind: 'candidates', candidates: [{ candidate: 'c' }], restart: 1 },
      { kind: 'candidates', candidates: [] },
      { kind: 'candidates', candidates: Array.from({ length: 21 }, () => ({ candidate: 'c' })) },
      { kind: 'candidates', candidates: [{ candidate: 'c'.repeat(513) }] },
      { kind: 'audio', data: 'AAAA' },
      { kind: 'video', frame: 'AAAA' },
    ];
    for (const body of bad) {
      expect((await api(alice).post(`/calls/${callId}/signal`, body)).status).toBe(400);
    }
    expect(
      (await api(alice).post('/calls/not-a-uuid/signal', { kind: 'offer', sdp: SDP })).status,
    ).toBe(400);
  });

  it('never stores SDP or candidates, and a finished call accepts no more signaling', async () => {
    const callId = await answered();
    await api(alice).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: SDP }).expect(204);

    const stored = [];
    for (const key of await ctx.redis.keys('*')) {
      const type = await ctx.redis.type(key);
      if (type === 'hash') stored.push(JSON.stringify(await ctx.redis.hgetall(key)));
      if (type === 'string') stored.push(String(await ctx.redis.get(key)));
    }
    expect(stored.join('\n')).not.toContain('v=0');
    expect(stored.join('\n')).not.toContain('candidate');

    await api(bob).post(`/calls/${callId}/end`, {}).expect(204);
    const replay = await api(alice).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: SDP });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('CALL_ENDED');
  });

  it("an old call's id cannot act on or reach a newer call between the same two people", async () => {
    const old = await answered();
    await api(alice).post(`/calls/${old}/end`, { reason: 'hangup' }).expect(204);
    const current = await answered();
    const published = ctx.realtime.published.length;

    // Every action replayed against the finished call is refused, for both participants.
    const replays = [
      [alice, 'signal', { kind: 'offer', sdp: SDP, restart: 1 }],
      [bob, 'signal', { kind: 'answer', sdp: SDP, restart: 1 }],
      [
        bob,
        'signal',
        { kind: 'candidates', candidates: [{ candidate: 'candidate:1 1 udp 1 x 1 typ host' }] },
      ],
      [bob, 'accept', undefined],
      [bob, 'reject', undefined],
    ];
    for (const [who, action, body] of replays) {
      const res = await api(who).post(`/calls/${old}/${action}`, body);
      expect([action, res.status, res.body.error?.code]).toEqual([action, 409, 'CALL_ENDED']);
    }
    // Ending it again is a no-op (idempotent), and none of it was relayed anywhere.
    await api(bob).post(`/calls/${old}/end`, { reason: 'hangup' }).expect(204);
    expect(ctx.realtime.published.length).toBe(published);

    // The newer call is untouched and still relays normally.
    expect((await api(alice).get('/calls/current')).body.call).toMatchObject({
      callId: current,
      status: 'accepted',
    });
    await api(alice).post(`/calls/${current}/signal`, { kind: 'offer', sdp: SDP }).expect(204);
    expect(callEvents(bob).at(-1)).toMatchObject({ callId: current, kind: 'offer' });
  });

  it('a third person can neither send nor receive signaling for a call between two others', async () => {
    const callId = await answered();
    for (const kind of ['offer', 'answer']) {
      const res = await api(carol).post(`/calls/${callId}/signal`, { kind, sdp: SDP });
      expect(res.status).toBe(404); // indistinguishable from a call that does not exist
    }
    await api(alice).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: SDP }).expect(204);
    expect(callEvents(carol)).toEqual([]);
  });

  it('refuses to relay a signal larger than a Pusher event instead of losing it silently', async () => {
    const callId = await answered();
    // Within the per-field limits, but 20 candidates of 512 characters exceed 10 KB together.
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      candidate: `candidate:${i} ${'x'.repeat(500)}`.slice(0, 512),
      sdpMid: '0',
      sdpMLineIndex: 0,
    }));
    const res = await api(alice).post(`/calls/${callId}/signal`, {
      kind: 'candidates',
      candidates,
    });
    expect([res.status, res.body.error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    expect(callEvents(bob).filter((e) => e.type === 'signal')).toEqual([]);
    // An offer at the SDP limit, shaped like a real one (lines of ~36 characters, as measured
    // on a phone: 3,794 characters in 105 lines; JSON doubles each line break), still fits.
    const line = `a=${'x'.repeat(32)}\r\n`;
    const largest = `v=0\r\n${line.repeat(240)}`.slice(0, 8000);
    await api(alice).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: largest }).expect(204);
    // A pathological one (5-character lines) does not, and is refused rather than lost.
    const dense = `v=0\r\n${'a=x\r\n'.repeat(1598)}`.slice(0, 8000);
    const refused = await api(alice).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: dense });
    expect(refused.status).toBe(413);
  });
});

describe('call-security attestations (Signal ciphertext, relayed only)', () => {
  // Opaque to the server: any well-formed Signal ciphertext of the allowed size.
  const ciphertext = (bytes = 2049, seed = 1) => Buffer.alloc(bytes, seed).toString('base64');
  const attest = (to, fields = {}) => ({
    kind: 'attest',
    attestation: { type: 3, body: ciphertext() },
    recipientRegistrationId: to.registrationId,
    ...fields,
  });

  it('relays an attestation either way once answered, with the sending device; to no one else', async () => {
    const callId = await startCall(alice, bob);
    const early = await api(alice).post(`/calls/${callId}/signal`, attest(bob));
    expect([early.status, early.body.error.code]).toEqual([409, 'CALL_INVALID_STATE']);

    await api(bob).post(`/calls/${callId}/accept`).expect(200);
    await api(alice).post(`/calls/${callId}/signal`, attest(bob)).expect(204);
    const reply = { type: 2, body: ciphertext(394, 2) };
    await api(bob)
      .post(`/calls/${callId}/signal`, attest(alice, { attestation: reply }))
      .expect(204);

    expect(callEvents(bob).filter((e) => e.type === 'signal')).toEqual([
      {
        type: 'signal',
        callId,
        kind: 'attest',
        attestation: { type: 3, body: ciphertext() },
        senderDeviceId: alice.deviceId,
      },
    ]);
    expect(callEvents(alice).filter((e) => e.type === 'signal')).toEqual([
      { type: 'signal', callId, kind: 'attest', attestation: reply, senderDeviceId: bob.deviceId },
    ]);
    expect(callEvents(carol)).toEqual([]);
    expect((await api(carol).post(`/calls/${callId}/signal`, attest(alice))).status).toBe(404);
    // No push for an attestation: the only push of the call is Bob's generic incoming-call one.
    await ctx.container.pushNotifier.idle();
    expect(pushes.map((p) => p.data.type)).toEqual(['incoming_call']);
    expect(JSON.stringify(pushes)).not.toContain(ciphertext().slice(0, 40));
  });

  it('refuses ciphertext for keys the recipient no longer has, so the sender rebuilds its session', async () => {
    const callId = await answered();
    const { Device } = await import('../src/models/Device.js');
    const newer = bob.registrationId === 16000 ? 1 : bob.registrationId + 1;
    await Device.updateOne(
      { deviceId: bob.deviceId },
      { $set: { 'signal.registrationId': newer } },
    );

    const stale = await api(alice).post(`/calls/${callId}/signal`, attest(bob));
    expect([stale.status, stale.body.error.code]).toEqual([409, 'STALE_RECIPIENT_DEVICE']);
    expect(callEvents(bob).filter((e) => e.type === 'signal')).toEqual([]);
    await api(alice)
      .post(`/calls/${callId}/signal`, attest(bob, { recipientRegistrationId: newer }))
      .expect(204);
    // As for messages, older clients may leave it out: then there is nothing to compare.
    await api(alice)
      .post(`/calls/${callId}/signal`, attest(bob, { recipientRegistrationId: undefined }))
      .expect(204);
  });

  it('rejects malformed or oversized attestations', async () => {
    const callId = await answered();
    const bad = [
      attest(bob, { attestation: { type: 3, body: '' } }),
      attest(bob, { attestation: { type: 3, body: 'not base64!' } }),
      attest(bob, { attestation: { type: 3, body: ciphertext(3 * 1024 + 1) } }),
      attest(bob, { attestation: { type: 1, body: ciphertext() } }),
      attest(bob, { attestation: { type: 3, body: ciphertext(), plaintext: 'x' } }),
      attest(bob, { attestation: undefined }),
      attest(bob, { fingerprints: ['sha-256 AB'] }), // nothing in clear next to the ciphertext
      attest(bob, { recipientRegistrationId: 0 }),
    ];
    for (const body of bad) {
      expect((await api(alice).post(`/calls/${callId}/signal`, body)).status).toBe(400);
    }
    expect(callEvents(bob).filter((e) => e.type === 'signal')).toEqual([]);
  });

  it('never stores attestations, and a finished call accepts no more of them', async () => {
    const callId = await answered();
    await api(alice).post(`/calls/${callId}/signal`, attest(bob)).expect(204);
    const stored = [];
    for (const key of await ctx.redis.keys('*')) {
      const type = await ctx.redis.type(key);
      if (type === 'hash') stored.push(JSON.stringify(await ctx.redis.hgetall(key)));
      if (type === 'string') stored.push(String(await ctx.redis.get(key)));
    }
    expect(stored.join('\n')).not.toContain(ciphertext().slice(0, 40));

    await api(bob).post(`/calls/${callId}/end`, {}).expect(204);
    const late = await api(alice).post(`/calls/${callId}/signal`, attest(bob));
    expect([late.status, late.body.error.code]).toEqual([409, 'CALL_ENDED']);
  });
});

describe('recovery and timeouts', () => {
  it('GET /calls/current returns this device’s call (and nothing for anyone else)', async () => {
    const callId = await startCall(alice, bob);

    expect((await api(bob).get('/calls/current')).body.call).toMatchObject({
      callId,
      role: 'callee',
      peerUserId: alice.id,
      status: 'ringing',
    });
    expect((await api(alice).get('/calls/current')).body.call).toMatchObject({
      callId,
      role: 'caller',
    });
    expect((await api(carol).get('/calls/current')).body.call).toBeNull();
    // Device ids are never exposed.
    expect(JSON.stringify((await api(bob).get('/calls/current')).body)).not.toContain(
      alice.deviceId,
    );
  });

  it('an unanswered call ends as missed for both after the ring timeout', async () => {
    await setup({ CALL_RING_TIMEOUT_SECONDS: '1' });
    const callId = await startCall(alice, bob);

    await ctx.container.callService.idle(); // the server's ring timer (1 s + grace)

    const missed = { type: 'ended', callId, status: 'missed', reason: 'no_answer' };
    expect(callEvents(alice).at(-1)).toEqual(missed);
    expect(callEvents(bob).at(-1)).toEqual(missed);
    expect((await api(bob).post(`/calls/${callId}/accept`)).body.error.code).toBe('CALL_ENDED');
    expect((await api(alice).get('/calls/current')).body.call).toBeNull();
  });

  it('an overdue ringing call is expired on read even if the timer was lost', async () => {
    await setup({ CALL_RING_TIMEOUT_SECONDS: '1' });
    const callId = await startCall(alice, bob);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5_000);
    try {
      expect((await api(bob).get('/calls/current')).body.call).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(callEvents(alice).at(-1)).toMatchObject({ callId, status: 'missed' });
    await ctx.container.callService.idle();
  });
});

describe('missed-call notes for the callee’s call history', () => {
  const missedOf = async (user) => {
    const res = await api(user).get('/calls/missed');
    expect(res.status).toBe(200);
    return res.body.missed;
  };

  it('an unanswered or cancelled call leaves only the callee a note until their phone collects it', async () => {
    await setup({ CALL_RING_TIMEOUT_SECONDS: '1' });
    const timedOut = await startCall(alice, bob);
    await ctx.container.callService.idle(); // rang out
    const cancelled = await startCall(alice, bob);
    await api(alice).post(`/calls/${cancelled}/end`, {}).expect(204); // caller gave up

    const notes = await missedOf(bob);
    expect(notes.map((n) => n.callId)).toEqual([timedOut, cancelled]); // oldest first
    for (const note of notes) {
      // Who called and when: nothing else (no device ids, no status details).
      expect(Object.keys(note).sort()).toEqual([
        'callId',
        'callerUserId',
        'createdAt',
        'endedAt',
        'kind',
      ]);
      expect(note.callerUserId).toBe(alice.id);
      expect(Date.parse(note.endedAt)).toBeGreaterThanOrEqual(Date.parse(note.createdAt));
    }
    expect(JSON.stringify(notes)).not.toContain(alice.deviceId);
    expect(await missedOf(alice)).toEqual([]); // the caller knows their own calls
    expect(await missedOf(carol)).toEqual([]);

    // Kept for a week at most, even if the phone never comes back.
    const ttl = await ctx.redis.pttl(`call:missed:${bob.id}`);
    expect(ttl).toBeGreaterThan(6 * 24 * 3600 * 1000);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);

    // Someone else cannot clear Bob's notes; Bob's acknowledgement does, idempotently.
    await api(carol)
      .post('/calls/missed/ack', { callIds: [timedOut] })
      .expect(204);
    expect(await missedOf(bob)).toHaveLength(2);
    await api(bob)
      .post('/calls/missed/ack', { callIds: [timedOut] })
      .expect(204);
    await api(bob)
      .post('/calls/missed/ack', { callIds: [timedOut] })
      .expect(204);
    expect((await missedOf(bob)).map((n) => n.callId)).toEqual([cancelled]);
  });

  it('answered, declined and failed calls leave no note (the callee’s phone saw them)', async () => {
    const answeredCall = await answered();
    await api(alice).post(`/calls/${answeredCall}/end`, {}).expect(204);
    const declined = await startCall(alice, bob);
    await api(bob).post(`/calls/${declined}/reject`).expect(204);
    const failed = await answered();
    await api(bob).post(`/calls/${failed}/end`, { reason: 'connection_lost' }).expect(204);

    expect(await missedOf(bob)).toEqual([]);
  });

  it('validates acknowledgements', async () => {
    const ack = (body) => api(bob).post('/calls/missed/ack', body);
    expect((await ack({ callIds: [] })).status).toBe(400);
    expect((await ack({ callIds: ['not-a-call-id'] })).status).toBe(400);
    expect((await ack({ callIds: Array.from({ length: 101 }, () => randomUUID()) })).status).toBe(
      400,
    );
    expect((await ack({ callIds: [randomUUID()], extra: 1 })).status).toBe(400);
    expect((await request(ctx.app).get('/calls/missed')).status).toBe(401);
    expect((await request(ctx.app).post('/calls/missed/ack').send({})).status).toBe(401);
  });

  it('keeps a bounded number of notes per person', async () => {
    const { createCallStore } = await import('../src/modules/calls/callStore.js');
    const store = createCallStore(ctx.redis);
    const note = (callId) => ({ callId, callerUserId: alice.id, createdAt: '', endedAt: '' });
    const limits = { ttlMs: 60_000, max: 2 };
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    expect(await store.addMissed(carol.id, note(a), limits)).toBe(true);
    expect(await store.addMissed(carol.id, note(b), limits)).toBe(true);
    expect(await store.addMissed(carol.id, note(c), limits)).toBe(false); // full
    expect(await store.addMissed(carol.id, note(a), limits)).toBe(true); // same call: kept
    expect((await store.listMissed(carol.id)).map((n) => n.callId).sort()).toEqual([a, b].sort());
  });

  it('a caller deleting their account mid-ring still leaves a note; the callee’s own deletion removes theirs', async () => {
    await startCall(alice, bob);
    await api(alice).delete('/account').expect(204);
    expect(await missedOf(bob)).toHaveLength(1);

    await api(bob).delete('/account').expect(204);
    expect(await ctx.redis.exists(`call:missed:${bob.id}`)).toBe(0);
  });
});

describe('sign-out, revocation and account deletion end the call', () => {
  it('logout ends the call and tells the other side', async () => {
    const callId = await answered();
    await api(bob).post('/auth/logout').expect(204);
    expect(callEvents(alice).at(-1)).toEqual({
      type: 'ended',
      callId,
      status: 'ended',
      reason: 'signed_out',
    });
    expect((await api(alice).get('/calls/current')).body.call).toBeNull();
  });

  it('signing in on another phone ends the call on the old one', async () => {
    const callId = await answered();
    await ctx.redis.del(...(await ctx.redis.keys('otp*'))); // OTP resend cooldown
    await login(ctx, BOB, newDevice());
    expect(callEvents(alice).at(-1)).toMatchObject({ callId, reason: 'signed_in_elsewhere' });
  });

  it('revoking the device in a call ends it; revoking another device does not', async () => {
    const callId = await answered();
    await api(bob).delete(`/devices/${randomUUID()}`).expect(404);
    expect((await api(alice).get('/calls/current')).body.call).not.toBeNull();

    await api(bob).delete(`/devices/${bob.deviceId}`).expect(204);
    expect(callEvents(alice).at(-1)).toMatchObject({ callId, reason: 'device_revoked' });
  });

  it('deleting the account ends the call', async () => {
    const callId = await answered();
    await api(alice).delete('/account').expect(204);
    expect(callEvents(bob).at(-1)).toMatchObject({ callId, reason: 'account_deleted' });
    expect((await api(bob).get('/calls/current')).body.call).toBeNull();
  });
});

describe('STUN/TURN configuration', () => {
  it('mints short-lived TURN credentials per call; the shared secret never leaves the server', async () => {
    await setup({
      TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349',
      TURN_SECRET,
      TURN_CREDENTIAL_TTL_SECONDS: '600',
      CALL_MAX_DURATION_SECONDS: '300', // credentials must outlive the longest call
      STUN_URLS: 'stun:turn.example.com:3478',
    });
    const res = await api(alice).post('/calls', { calleeUserId: bob.id });
    const callId = res.body.call.callId;
    expect(res.body.iceTransportPolicy).toBe('all');
    const [stun, turn] = res.body.iceServers;

    expect(stun).toEqual({ urls: ['stun:turn.example.com:3478'] });
    expect(turn.urls).toEqual([
      'turn:turn.example.com:3478?transport=udp',
      'turns:turn.example.com:5349',
    ]);
    const [expiry, opaque] = turn.username.split(':');
    expect(opaque).toBe(callId); // no user id given to the TURN server
    expect(Number(expiry) - Date.now() / 1000).toBeGreaterThan(590);
    expect(Number(expiry) - Date.now() / 1000).toBeLessThanOrEqual(600);
    expect(turn.credential).toBe(
      createHmac('sha1', TURN_SECRET).update(turn.username).digest('base64'),
    );

    const accept = await api(bob).post(`/calls/${callId}/accept`);
    expect(accept.body.iceServers[1].username).toMatch(new RegExp(`^\\d+:${callId}$`));

    // Credentials go only in the two HTTPS responses: never in Pusher events, pushes, logs,
    // the recovery view of the call, or Redis.
    const current = (await api(alice).get('/calls/current')).body;
    expect(current.call).not.toHaveProperty('iceServers');
    const stored = [];
    for (const key of await ctx.redis.keys('*')) {
      const type = await ctx.redis.type(key);
      if (type === 'hash') stored.push(JSON.stringify(await ctx.redis.hgetall(key)));
      if (type === 'string') stored.push(String(await ctx.redis.get(key)));
    }
    const everywhereElse = JSON.stringify([
      ctx.realtime.published,
      pushes,
      ctx.lines,
      current,
      stored,
    ]);
    expect(everywhereElse).not.toContain(turn.credential);
    expect(everywhereElse).not.toContain(accept.body.iceServers[1].credential);
    expect(everywhereElse).not.toContain(TURN_SECRET);
    expect(JSON.stringify([res.body, accept.body])).not.toContain(TURN_SECRET);
  });

  it('accepts only plain STUN/TURN URIs: no credentials in URLs, valid ports and transports', async () => {
    const { parseIceUrl } = await import('../src/config/env.js');
    for (const url of [
      'turn:turn.example.com',
      'turn:turn.example.com:3478?transport=udp',
      'turn:turn.example.com:3478?transport=tcp',
      'turns:turn.example.com:5349',
      'turns:turn.example.com:443?transport=tcp',
      'turn:192.0.2.10:3478',
      'turn:[2001:db8::1]:3478',
      'stun:stun.example.com:3478',
      'stuns:stun.example.com',
    ]) {
      expect(parseIceUrl(url), url).not.toBeNull();
    }
    for (const url of [
      'turn:user:password@turn.example.com:3478', // credentials would reach every phone
      'turn:user@turn.example.com',
      'turn://turn.example.com:3478',
      'turn:turn.example.com:3478/path',
      'turn:turn.example.com:0',
      'turn:turn.example.com:70000',
      'turn:turn.example.com:3478?transport=sctp',
      'turns:turn.example.com:5349?transport=udp', // turns: is TLS over TCP
      'stun:stun.example.com:3478?transport=udp', // STUN URIs have no transport
      'turn: turn.example.com',
      'https://turn.example.com',
    ]) {
      expect(parseIceUrl(url), url).toBeNull();
    }
    expect(() =>
      loadEnv({ ...TEST_ENV, TURN_URLS: 'turn:user:password@turn.example.com', TURN_SECRET }),
    ).toThrow(/TURN_URLS/);
    expect(() => loadEnv({ ...TEST_ENV, STUN_URLS: 'turn:turn.example.com' })).toThrow(/STUN_URLS/);
  });

  it('keeps the TURN secret separate, out of error messages, and valid for the longest call', () => {
    const turn = { TURN_URLS: 'turn:turn.example.com:3478', TURN_SECRET };
    // Shared with the TURN server: it must not be able to sign tokens or OTP hashes.
    for (const reused of [TEST_ENV.JWT_ACCESS_SECRET, TEST_ENV.OTP_HMAC_SECRET]) {
      expect(() => loadEnv({ ...TEST_ENV, ...turn, TURN_SECRET: reused })).toThrow(/TURN_SECRET/);
    }

    // Credentials expiring mid-call would cut a relayed call's audio.
    const lifetime = (ttl, ring, max) => () =>
      loadEnv({
        ...TEST_ENV,
        ...turn,
        TURN_CREDENTIAL_TTL_SECONDS: String(ttl),
        CALL_RING_TIMEOUT_SECONDS: String(ring),
        CALL_MAX_DURATION_SECONDS: String(max),
      });
    expect(lifetime(3600, 45, 3600)).toThrow(/TURN_CREDENTIAL_TTL_SECONDS/);
    expect(lifetime(3645, 45, 3600)).not.toThrow();
    expect(loadEnv({ ...TEST_ENV, ...turn }).calls.turn.credentialTtlSeconds).toBe(18_000);

    // Validation errors name the variable, never its value.
    let message = '';
    try {
      loadEnv({ ...TEST_ENV, TURN_URLS: 'turn:user:pw@bad', TURN_SECRET });
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/TURN_URLS/);
    expect(message).not.toContain(TURN_SECRET);
    expect(message).not.toContain('user:pw');
  });

  it('relay-only mode sends media through TURN only, and needs TURN', async () => {
    expect(() => loadEnv({ ...TEST_ENV, ICE_TRANSPORT_POLICY: 'relay' })).toThrow(
      /ICE_TRANSPORT_POLICY/,
    );
    expect(() => loadEnv({ ...TEST_ENV, ICE_TRANSPORT_POLICY: 'direct' })).toThrow();
    expect(loadEnv({ ...TEST_ENV }).calls.iceTransportPolicy).toBe('all');

    await setup({
      TURN_URLS: 'turns:turn.example.com:5349',
      TURN_SECRET,
      ICE_TRANSPORT_POLICY: 'relay',
    });
    const start = await api(alice).post('/calls', { calleeUserId: bob.id });
    expect(start.body.iceTransportPolicy).toBe('relay');
    const accept = await api(bob).post(`/calls/${start.body.call.callId}/accept`);
    expect(accept.body.iceTransportPolicy).toBe('relay');
    expect(accept.body.iceServers.at(-1).urls).toEqual(['turns:turn.example.com:5349']);
  });

  it('the documented .env.example call settings load, and leave TURN off until filled in', async () => {
    const { readFileSync } = await import('node:fs');
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const settings = Object.fromEntries(
      example
        .split(/\r?\n/)
        .map((line) => /^((?:CALL|STUN|TURN|ICE)_[A-Z_]+)=(.*)$/.exec(line))
        .filter(Boolean)
        .map(([, key, value]) => [key, value]),
    );
    expect(Object.keys(settings)).not.toContain('TURN_SECRET'); // never pre-filled
    const config = loadEnv({ ...TEST_ENV, ...settings }).calls;
    expect(config.turn).toBeNull();
    expect(config.stunUrls).toEqual(['stun:stun.l.google.com:19302']);
    expect(config.iceTransportPolicy).toBe('all');
  });

  it('refuses half or invalid TURN configuration at startup', () => {
    const bad = [
      { TURN_URLS: 'turn:turn.example.com' },
      { TURN_SECRET },
      { TURN_URLS: 'http://turn.example.com', TURN_SECRET },
      { TURN_URLS: 'turn:turn.example.com', TURN_SECRET: 'short' },
      { STUN_URLS: 'https://stun.example.com' },
    ];
    for (const env of bad) expect(() => loadEnv({ ...TEST_ENV, ...env })).toThrow();
    expect(loadEnv({ ...TEST_ENV }).calls.turn).toBeNull();
  });
});

describe('no sensitive data in logs or events', () => {
  it('a whole call leaves no SDP, candidates, tokens or phone numbers in logs or events', async () => {
    const callId = await answered();
    await api(alice).post(`/calls/${callId}/signal`, { kind: 'offer', sdp: SDP }).expect(204);
    await api(alice).post(`/calls/${callId}/end`, {}).expect(204);

    const logs = JSON.stringify(ctx.lines);
    for (const secret of [SDP, 'v=0', alice.token, bob.token, ALICE, BOB]) {
      expect(logs).not.toContain(secret);
    }
    // Payloads only: a device id is (by design) part of its own channel's name.
    const payloads = JSON.stringify(ctx.realtime.published.map((p) => p.payload));
    for (const secret of [alice.token, bob.token, alice.refreshToken, ALICE, BOB, alice.deviceId]) {
      expect(payloads).not.toContain(secret);
    }
  });
});
