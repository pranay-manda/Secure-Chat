/* global jest */
import { LIMITS } from '@secure-chat/shared/constants';

/**
 * Call security (R2): each phone proves its DTLS certificate to the other through Signal.
 *
 * Part 1 tests the pure rules (callSecurity.js). Part 2 runs two complete app instances (A, B)
 * with the REAL libsignal (mocks/signalNativeMock.js) and a fake WebRTC whose every connection
 * has its own random certificate, against an in-memory server that relays calls like the API.
 * A fake connection "passes DTLS" only if its remote description names the other side's real
 * certificate. No audio, network or real WebRTC is involved: two physical phones are still
 * needed to verify calls end to end.
 */
jest.setTimeout(30_000);

jest.mock('../src/calls/media', () => {
  const { randomBytes } = require('node:crypto');
  const state = { pcs: [] };
  const hex = (bytes) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
      .join(':')
      .toUpperCase();
  class FakePeerConnection {
    constructor() {
      this.certificate = `sha-256 ${hex(randomBytes(32))}`; // this connection's own DTLS cert
      this.listeners = {};
      this.signalingState = 'stable';
      this.localDescription = null;
      this.remoteDescription = null;
      this.remoteDescriptionCalls = 0;
      this.connectionState = 'new';
      this.restarts = 0;
      this.closed = false;
      state.pcs.push(this);
    }
    addEventListener(event, handler) {
      (this.listeners[event] ??= new Set()).add(handler);
    }
    removeEventListener(event, handler) {
      this.listeners[event]?.delete(handler);
    }
    addTrack(track) {
      return { track, replaceTrack: async () => {} };
    }
    /** Shaped like libwebrtc's: the certificate fingerprint on every m-section. */
    description(type) {
      const media = (mid, kind) => [
        `m=${kind} 9 UDP/TLS/RTP/SAVPF 111`,
        `a=ice-ufrag:u${this.restarts}`,
        `a=fingerprint:${this.certificate}`,
        `a=setup:${type === 'offer' ? 'actpass' : 'active'}`,
        `a=mid:${mid}`,
      ];
      const lines = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1'];
      return `${[...lines, ...media(0, 'audio'), ...media(1, 'video')].join('\r\n')}\r\n`;
    }
    async createOffer() {
      return { type: 'offer', sdp: this.description('offer') };
    }
    async createAnswer() {
      return { type: 'answer', sdp: this.description('answer') };
    }
    async setLocalDescription(description) {
      this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
      this.localDescription = { ...description };
    }
    async setRemoteDescription(description) {
      this.remoteDescriptionCalls += 1;
      this.remoteDescription = description;
      this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    async addIceCandidate() {}
    restartIce() {
      this.restarts += 1;
    }
    close() {
      this.closed = true;
      this.connectionState = 'closed';
    }
    setConnectionState(value) {
      this.connectionState = value;
      for (const handler of this.listeners.connectionstatechange ?? []) handler({});
    }
    /** What DTLS checks: the other side's certificate is the one our remote description names. */
    trusts(other) {
      return Boolean(this.remoteDescription?.sdp.includes(`a=fingerprint:${other.certificate}`));
    }
  }
  const stream = () => {
    const track = { kind: 'audio', enabled: true, stop() {} };
    return {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
      removeTrack() {},
      toURL: () => 'stream',
    };
  };
  const noop = () => {};
  return {
    __state: state,
    getMedia: async () => stream(),
    getMicrophone: async () => stream(),
    switchCamera: () => null,
    createPeerConnection: () => new FakePeerConnection(),
    getConnectionRoute: async () => null,
    toIceCandidate: (init) => ({ ...init }),
    toSessionDescription: (init) => ({ ...init }),
    audio: { start: noop, stop: noop, setSpeaker: noop, startRingtone: noop, stopRingtone: noop },
    keepAlive: { start: () => true, stop: noop },
  };
});

const security = () => require('../src/calls/callSecurity');
const contentModule = () => require('../src/messaging/content');
const FP = (byte) => `sha-256 ${Array(32).fill(byte).join(':')}`;

// --- Part 1: the rules ---------------------------------------------------------------------

describe('fingerprints in a description (strict, SHA-256 only)', () => {
  const sdp = (...fingerprintLines) =>
    ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', ...fingerprintLines, 'a=mid:0', ''].join('\r\n');

  it('reads the one certificate libwebrtc names on every m-section, in canonical form', () => {
    const lower = FP('ab').toLowerCase();
    expect(
      security().parseFingerprints(sdp(`a=fingerprint:${lower}`, `a=fingerprint:${FP('AB')}`)),
    ).toEqual({ ok: true, fingerprints: [FP('AB')] });
    expect(
      security().parseFingerprints(sdp(`a=fingerprint:SHA-256 ${FP('01').split(' ')[1]}`)),
    ).toEqual({ ok: true, fingerprints: [FP('01')] });
    // Two certificates are two entries (sorted), so both must have been attested.
    expect(
      security().parseFingerprints(sdp(`a=fingerprint:${FP('BB')}`, `a=fingerprint:${FP('AA')}`)),
    ).toEqual({ ok: true, fingerprints: [FP('AA'), FP('BB')] });
  });

  it.each([
    ['no fingerprint at all', sdp()],
    ['SHA-1', sdp(`a=fingerprint:sha-1 ${Array(20).fill('AB').join(':')}`)],
    ['SHA-384', sdp(`a=fingerprint:sha-384 ${Array(48).fill('AB').join(':')}`)],
    ['SHA-512', sdp(`a=fingerprint:sha-512 ${Array(64).fill('AB').join(':')}`)],
    ['a short value', sdp(`a=fingerprint:sha-256 ${Array(31).fill('AB').join(':')}`)],
    ['a long value', sdp(`a=fingerprint:sha-256 ${Array(33).fill('AB').join(':')}`)],
    ['non-hex', sdp(`a=fingerprint:sha-256 ${Array(32).fill('ZZ').join(':')}`)],
    ['extra spaces', sdp(`a=fingerprint:sha-256  ${FP('AB').split(' ')[1]}`)],
    ['trailing text', sdp(`a=fingerprint:${FP('AB')} extra`)],
    ['one good and one malformed line', sdp(`a=fingerprint:${FP('AB')}`, 'a=fingerprint:x')],
    ['no description', undefined],
  ])('%s: rejected', (_, description) => {
    expect(security().parseFingerprints(description)).toMatchObject({ ok: false });
  });

  it('compares exact sets', () => {
    const { sameFingerprints } = security();
    expect(sameFingerprints([FP('AA')], [FP('AA')])).toBe(true);
    expect(sameFingerprints([FP('AA')], [FP('BB')])).toBe(false);
    expect(sameFingerprints([FP('AA')], [FP('AA'), FP('BB')])).toBe(false);
    expect(sameFingerprints([FP('AA'), FP('BB')], [FP('AA')])).toBe(false);
    expect(sameFingerprints(null, [FP('AA')])).toBe(false);
  });
});

describe('an attestation is bound to its call, direction, people and kind', () => {
  const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const PEER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const CALL = '11111111-1111-4111-8111-111111111111';
  const expected = { callId: CALL, role: 'caller', from: PEER, to: ME, kind: 'voice' };
  const decoded = (fields = {}) =>
    contentModule().decodeContent(
      contentModule().encodeContent({
        ...security().attestationContent({ ...expected, fingerprints: [FP('CD'), FP('AB')] }),
        ...fields,
      }),
    );

  it('accepts its own call and returns the sorted fingerprint set', () => {
    expect(security().verifyAttestation(decoded(), expected)).toEqual({
      ok: true,
      fingerprints: [FP('AB'), FP('CD')],
    });
  });

  it.each([
    ['call', { callId: '22222222-2222-4222-8222-222222222222' }],
    ['role', { role: 'callee' }],
    ['peer', { from: 'cccccccccccccccccccccccc' }],
    ['peer', { to: 'cccccccccccccccccccccccc' }],
    ['kind', { kind: 'video' }],
  ])('rejects another %s', (reason, fields) => {
    expect(security().verifyAttestation(decoded(fields), expected)).toEqual({ ok: false, reason });
  });

  it('rejects anything that is not a valid attestation (text, legacy text, malformed)', () => {
    const { decodeContent, encodeContent, textContent } = contentModule();
    const verify = (bytes) => security().verifyAttestation(decodeContent(bytes), expected);
    expect(verify(encodeContent(textContent('hi')))).toMatchObject({ ok: false });
    expect(verify(new TextEncoder().encode(JSON.stringify({ type: 'call.dtls' })))).toMatchObject({
      ok: false,
    });
    const sha1 = { fingerprints: [`sha-1 ${Array(20).fill('AB').join(':')}`] };
    const raw = JSON.stringify({ ...security().attestationContent(expected), ...sha1 });
    expect(verify(Uint8Array.of(0xff, ...new TextEncoder().encode(raw)))).toMatchObject({
      ok: false,
    });
  });

  it('a received ciphertext is checked and put in canonical form', () => {
    const { canonicalCiphertext } = security();
    const body = Buffer.alloc(100, 7).toString('base64');
    expect(canonicalCiphertext({ type: 3, body })).toEqual({ type: 3, body });
    for (const bad of [
      null,
      { type: 1, body },
      { type: 2, body: '' },
      { type: 2, body: 'not base64!' },
      { type: 2, body: Buffer.alloc(3 * 1024 + 1).toString('base64') },
    ]) {
      expect(canonicalCiphertext(bad)).toBeNull();
    }
  });
});

// --- Part 2: two phones, real Signal -------------------------------------------------------

const USERS = {
  A: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', phone: '+919876543210', deviceId: null },
  B: { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', phone: '+919812345678', deviceId: null },
};
const PUSHER_KEY = 'public-pusher-key';

let storage;
let apps;
let server;

const nameOf = (userId) => Object.keys(USERS).find((k) => USERS[k].id === userId);
const freshStorage = () => ({
  secureStore: new Map(),
  sqliteFiles: new Map(),
  sqliteBroken: false,
});

function boot(name) {
  globalThis.__device = storage[name];
  jest.isolateModules(() => {
    apps[name] = {
      auth: require('../src/auth/authStore'),
      signal: require('../src/crypto/signalService'),
      store: require('../src/crypto/signalStore'),
      engine: require('../src/messaging/messagingEngine'),
      messages: require('../src/messaging/messageStore'),
      calls: require('../src/calls/callEngine'),
      media: require('../src/calls/media'),
      db: require('../src/db/database'),
    };
  });
  return apps[name];
}

async function settle(name) {
  globalThis.__device = storage[name];
  for (let i = 0; i < 4; i += 1) {
    await storage[name].pusher?.ready;
    await apps[name].engine.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function as(name, fn) {
  globalThis.__device = storage[name];
  const result = await fn(apps[name]);
  await settle(name);
  return result;
}

/**
 * Lets device `name` work (its calls engine runs on its own promises) until `done()` holds,
 * keeping this device's storage selected meanwhile, then settles it.
 */
async function until(name, done, what = 'condition') {
  globalThis.__device = storage[name];
  const deadline = Date.now() + 8000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    globalThis.__device = storage[name];
  }
  await settle(name);
}

/** Delivers queued realtime events to a device (through its Pusher connection). */
async function deliver(name, filter = () => true) {
  globalThis.__device = storage[name];
  const queued = server.realtimeQueue.filter((e) => e.device === name && filter(e));
  server.realtimeQueue = server.realtimeQueue.filter((e) => !queued.includes(e));
  for (const e of queued) storage[name].pusher?.deliver(e.channel, e.event, e.data);
  await settle(name);
  return queued;
}

const callState = (name) => apps[name].calls.useCallStore.getState();
const pcOf = (name) => apps[name].media.__state.pcs.at(-1);
const queuedFor = (name, kind) =>
  server.realtimeQueue.filter(
    (e) => e.device === name && e.event === 'call' && (!kind || e.data.kind === kind),
  );

function createServer() {
  const state = {
    devices: {},
    messages: [],
    envelopes: [],
    seq: {},
    requests: [],
    published: [],
    realtimeQueue: [],
    calls: new Map(),
    current: {},
    tamper: null, // (event, fromName) => event to relay, or null to drop it
  };
  const channelOf = (userId) => `private-device-${USERS[nameOf(userId)].deviceId}`;
  const publish = (userId, event, data) => {
    const e = { device: nameOf(userId), channel: channelOf(userId), event, data };
    state.published.push(e);
    state.realtimeQueue.push(e);
  };
  const userByToken = (headers) =>
    Object.keys(USERS).find((k) => headers.Authorization === `Bearer token-${k}`);
  const callView = (call, role) => ({
    callId: call.callId,
    role,
    peerUserId: role === 'caller' ? call.callee : call.caller,
    kind: call.kind,
    status: call.status,
    createdAt: call.createdAt,
    ringExpiresAt: call.ringExpiresAt,
  });
  const participant = (me, callId) => {
    const call = state.calls.get(callId);
    if (!call) return null;
    if (call.caller === USERS[me].id) return { call, role: 'caller', other: call.callee };
    if (call.callee === USERS[me].id) return { call, role: 'callee', other: call.caller };
    return null;
  };
  const ended = { status: 409, body: { error: { code: 'CALL_ENDED' } } };
  const terminal = (call) => !['ringing', 'accepted'].includes(call.status);
  const finishCall = (call, status) => {
    call.status = status;
    for (const name of Object.keys(state.current)) {
      if (state.current[name] === call.callId) delete state.current[name];
    }
  };

  const handlers = [
    [
      'POST',
      /^\/auth\/otp\/verify$/,
      ({ body }) => {
        const key = Object.keys(USERS).find((k) => USERS[k].phone === body.phoneNumber);
        USERS[key].deviceId = body.device.deviceId;
        delete state.devices[USERS[key].id]; // a login clears the device's keys
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
        const sender = USERS[me];
        const recipient = USERS[nameOf(body.recipientUserId)];
        const keys = state.devices[recipient.id];
        if (
          !keys?.signal ||
          keys.deviceId !== body.recipientDeviceId ||
          (body.recipientRegistrationId != null &&
            keys.signal.registrationId !== body.recipientRegistrationId)
        ) {
          return { status: 409, body: { error: { code: 'STALE_RECIPIENT_DEVICE' } } };
        }
        state.seq[recipient.id] = (state.seq[recipient.id] ?? 0) + 1;
        const seq = state.seq[recipient.id];
        const id = `${'m'.repeat(18)}${String(state.messages.length + 1).padStart(6, '0')}`;
        state.messages.push({ id, seq, senderUserId: sender.id, recipientUserId: recipient.id });
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
        publish(
          recipient.id,
          'envelope',
          inline
            ? { envelopeId: envelope.envelopeId, seq, inline: true, envelope }
            : { envelopeId: envelope.envelopeId, seq, inline: false },
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
            .map(({ recipientUserId, delivered, ...e }) => e),
        },
      }),
    ],
    [
      'POST',
      /^\/messages\/envelopes\/ack$/,
      ({ me, body }) => {
        const acked = state.envelopes.filter(
          (e) => e.recipientUserId === USERS[me].id && e.seq <= body.upToSeq && !e.delivered,
        );
        for (const e of acked) e.delivered = true;
        return { body: { acknowledged: acked.length } };
      },
    ],
    ['POST', /^\/messages\/read$/, () => ({ body: { updated: 0 } })],
    ['POST', /^\/messages\/status$/, () => ({ body: { statuses: [] } })],
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
    ['POST', /^\/presence\/heartbeat$/, () => ({ status: 204 })],
    ['DELETE', /^\/presence$/, () => ({ status: 204 })],
    ['GET', /^\/calls\/missed$/, () => ({ body: { missed: [] } })],
    ['POST', /^\/calls\/missed\/ack$/, () => ({ status: 204 })],
    [
      'GET',
      /^\/calls\/current$/,
      ({ me }) => {
        const call = state.calls.get(state.current[me]);
        if (!call || terminal(call)) return { body: { call: null } };
        return {
          body: { call: callView(call, call.caller === USERS[me].id ? 'caller' : 'callee') },
        };
      },
    ],
    [
      'POST',
      /^\/calls$/,
      ({ me, body }) => {
        const now = Date.now();
        const call = {
          callId: crypto.randomUUID(),
          caller: USERS[me].id,
          callee: body.calleeUserId,
          kind: body.kind ?? 'voice',
          status: 'ringing',
          createdAt: new Date(now).toISOString(),
          ringExpiresAt: new Date(now + 45_000).toISOString(),
        };
        state.calls.set(call.callId, call);
        state.current[me] = call.callId;
        state.current[nameOf(call.callee)] = call.callId;
        publish(call.callee, 'call', {
          type: 'invite',
          callId: call.callId,
          callerUserId: call.caller,
          kind: call.kind,
          createdAt: call.createdAt,
          ringExpiresAt: call.ringExpiresAt,
        });
        return { status: 201, body: { call: callView(call, 'caller'), iceServers: [] } };
      },
    ],
    [
      'POST',
      /^\/calls\/([\w-]+)\/accept$/,
      ({ me, match }) => {
        const found = participant(me, match[1]);
        if (!found || found.role !== 'callee') return { status: 404 };
        if (terminal(found.call)) return ended;
        found.call.status = 'accepted';
        publish(found.other, 'call', { type: 'accepted', callId: found.call.callId });
        return { body: { call: callView(found.call, 'callee'), iceServers: [] } };
      },
    ],
    [
      'POST',
      /^\/calls\/([\w-]+)\/(reject|end)$/,
      ({ me, match, body }) => {
        const found = participant(me, match[1]);
        if (!found) return { status: 404 };
        if (!terminal(found.call)) {
          const status = match[2] === 'reject' ? 'rejected' : 'ended';
          finishCall(found.call, status);
          publish(found.other, 'call', {
            type: 'ended',
            callId: found.call.callId,
            status,
            reason: body?.reason ?? 'hangup',
          });
        }
        return { status: 204 };
      },
    ],
    [
      'POST',
      /^\/calls\/([\w-]+)\/signal$/,
      ({ me, match, body }) => {
        const found = participant(me, match[1]);
        if (!found) return { status: 404 };
        if (terminal(found.call)) return ended;
        if (found.call.status !== 'accepted') {
          return { status: 409, body: { error: { code: 'CALL_INVALID_STATE' } } };
        }
        let event;
        if (body.kind === 'attest') {
          const keys = state.devices[found.other];
          if (
            body.recipientRegistrationId !== undefined &&
            keys?.signal?.registrationId !== body.recipientRegistrationId
          ) {
            return { status: 409, body: { error: { code: 'STALE_RECIPIENT_DEVICE' } } };
          }
          event = {
            type: 'signal',
            callId: found.call.callId,
            kind: 'attest',
            attestation: body.attestation,
            senderDeviceId: USERS[me].deviceId,
          };
        } else {
          event = { type: 'signal', callId: found.call.callId, ...body };
        }
        const relayed = state.tamper ? state.tamper(event, me) : event;
        if (relayed) publish(found.other, 'call', relayed);
        return { status: 204 };
      },
    ],
  ];

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

async function signInAgain(name) {
  await as(name, (app) => app.auth.useAuthStore.getState().logout());
  boot(name);
  await signInAndStart(name);
}

const send = (from, to, text) =>
  as(from, (app) => app.engine.sendMessage(USERS[from].id, USERS[to].id, text));
const chat = (name, peer) => as(name, (app) => app.messages.listChatMessages(USERS[peer].id));

/** A rings B, B answers: until A's offer (with its attestation) is queued for B. */
async function ringAndAnswer(from = 'A', to = 'B') {
  await as(from, (app) => app.calls.startCall(USERS[to].id));
  await deliver(to);
  await until(to, () => callState(to).phase === 'incoming', 'ringing');
  await as(to, (app) => app.calls.answerCall());
  await deliver(from); // "accepted"
  await until(from, () => queuedFor(to, 'offer').length > 0, 'offer sent');
}

/** Runs the rest of the negotiation; the fake DTLS check then decides whether both connect. */
async function negotiate(from = 'A', to = 'B') {
  await deliver(to);
  await until(
    to,
    () => queuedFor(from, 'answer').length > 0 || callState(to).phase === 'ended',
    'answer or failure',
  );
  await deliver(from);
  await until(
    from,
    () => pcOf(from).remoteDescription !== null || callState(from).phase === 'ended',
    'answer applied or failure',
  );
}

function connectIfDtlsAgrees(from = 'A', to = 'B') {
  const [caller, callee] = [pcOf(from), pcOf(to)];
  const agreed = caller.trusts(callee) && callee.trusts(caller);
  if (agreed) {
    globalThis.__device = storage[from];
    caller.setConnectionState('connected');
    globalThis.__device = storage[to];
    callee.setConnectionState('connected');
  }
  return agreed;
}

const attestEvents = (to) =>
  server.published.filter((e) => e.device === to && e.data?.kind === 'attest');

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
    apps[name].calls.endCallForSignOut();
    apps[name].engine.stopMessaging();
  }
});

describe('two phones, real Signal: attested DTLS fingerprints', () => {
  it('first contact: the caller attests with a pre-key message, the callee replies; both verify', async () => {
    await ringAndAnswer();
    await negotiate();

    expect(attestEvents('B').map((e) => e.data.attestation.type)).toEqual([3]); // PreKey
    expect(attestEvents('A').map((e) => e.data.attestation.type)).toEqual([2]); // Whisper
    expect(attestEvents('B')[0].data.senderDeviceId).toBe(USERS.A.deviceId);
    expect(connectIfDtlsAgrees()).toBe(true);
    expect(callState('A').phase).toBe('connected');
    expect(callState('B').phase).toBe('connected');
  });

  it('an established session: both attestations are regular Signal messages', async () => {
    await send('A', 'B', 'Hello');
    await deliver('B');
    await send('B', 'A', 'Hi');
    await deliver('A');

    await ringAndAnswer();
    await negotiate();
    expect(attestEvents('B').map((e) => e.data.attestation.type)).toEqual([2]);
    expect(attestEvents('A').map((e) => e.data.attestation.type)).toEqual([2]);
    expect(connectIfDtlsAgrees()).toBe(true);
  });

  it('attestations never reach the chat, the server or Pusher in readable form', async () => {
    await ringAndAnswer();
    await negotiate();
    expect(connectIfDtlsAgrees()).toBe(true);

    for (const [name, peer] of [
      ['A', 'B'],
      ['B', 'A'],
    ]) {
      expect(await chat(name, peer)).toEqual([]);
      const conversations = await as(name, (app) => app.messages.listConversations());
      expect(conversations.every((c) => c.unread === 0 && c.lastBody == null)).toBe(true);
    }
    expect(server.requests.some((r) => r.path === '/messages' || r.path === '/messages/read')).toBe(
      false,
    );
    // Relayed: ciphertext and ids only. No fingerprint, no content type, no plaintext JSON.
    const relayed = JSON.stringify(server.published.filter((e) => e.data?.kind === 'attest'));
    for (const secret of [pcOf('A').certificate, pcOf('B').certificate, 'call.dtls', '"role"']) {
      expect(relayed).not.toContain(secret.split(' ').at(-1));
    }
    const attestRequests = server.requests.filter((r) => r.body.includes('"attest"'));
    for (const request of attestRequests) expect(request.body).not.toContain('call.dtls');
  });

  it('the session a first-contact call creates is the one the chat continues on', async () => {
    await ringAndAnswer();
    await negotiate();
    expect(connectIfDtlsAgrees()).toBe(true);
    // B writes first, then A, before either message is delivered: both must still decrypt.
    await send('B', 'A', 'from B after the call');
    await send('A', 'B', 'from A after the call');
    await deliver('A');
    await deliver('B');
    expect((await chat('A', 'B')).map((m) => [m.direction, m.status, m.body])).toContainEqual([
      'in',
      'received',
      'from B after the call',
    ]);
    expect((await chat('B', 'A')).map((m) => [m.direction, m.status, m.body])).toContainEqual([
      'in',
      'received',
      'from A after the call',
    ]);
  });

  it('a duplicated attestation (Pusher, or a re-sent copy) is decrypted once; the call connects', async () => {
    await ringAndAnswer();
    const [copy] = queuedFor('B', 'attest');
    server.realtimeQueue.push({ ...copy }, { ...copy }); // delivered three times in all
    await negotiate();
    expect(callState('B').phase).not.toBe('ended');
    expect(connectIfDtlsAgrees()).toBe(true);
  });

  it('an attestation altered on the way fails the callee closed; nothing is applied', async () => {
    server.tamper = (event, from) => {
      if (event.kind !== 'attest' || from !== 'A') return event;
      const bytes = Buffer.from(event.attestation.body, 'base64');
      bytes[bytes.length - 3] ^= 0x01;
      return { ...event, attestation: { ...event.attestation, body: bytes.toString('base64') } };
    };
    await ringAndAnswer();
    await negotiate();
    expect(callState('B')).toMatchObject({ phase: 'ended', endReason: 'security_unverified' });
    expect(pcOf('B').remoteDescriptionCalls).toBe(0);
  });

  it('a fingerprint swapped into the offer on the way (a man in the middle) fails closed', async () => {
    const attacker = FP('EE');
    server.tamper = (event) =>
      event.kind === 'offer'
        ? {
            ...event,
            sdp: event.sdp.replace(/a=fingerprint:[^\r\n]+/g, `a=fingerprint:${attacker}`),
          }
        : event;
    await ringAndAnswer();
    await negotiate();
    expect(callState('B')).toMatchObject({ phase: 'ended', endReason: 'security_unverified' });
    expect(pcOf('B').remoteDescriptionCalls).toBe(0);
  });

  it('an attestation replayed from an earlier call fails the next call closed', async () => {
    await ringAndAnswer();
    const [old] = queuedFor('B', 'attest');
    await negotiate();
    expect(connectIfDtlsAgrees()).toBe(true);
    await as('A', (app) => app.calls.hangUp());
    await deliver('B');
    await until('B', () => callState('B').phase !== 'connected', 'call over');
    await new Promise((resolve) => setTimeout(resolve, 2600)); // ended screens clear

    server.tamper = (event, from) =>
      event.kind === 'attest' && from === 'A'
        ? { ...event, attestation: old.data.attestation }
        : event;
    await ringAndAnswer();
    await negotiate();
    expect(callState('B')).toMatchObject({ phase: 'ended', endReason: 'security_unverified' });
  });

  it('a callee who signed in again (new keys): one fresh session, the changed code stops the call', async () => {
    await send('A', 'B', 'Hello');
    await deliver('B');
    await send('B', 'A', 'Hi');
    await deliver('A');
    await signInAgain('B'); // new identity key and registration id on the same phone

    await as('A', (app) => app.calls.startCall(USERS.B.id));
    await deliver('B');
    await until('B', () => callState('B').phase === 'incoming', 'ringing');
    await as('B', (app) => app.calls.answerCall());
    await deliver('A');
    await until('A', () => callState('A').phase === 'ended', 'call refused');

    expect(callState('A').endReason).toBe('identity_changed');
    const refused = server.requests.filter(
      (r) => r.path.endsWith('/signal') && r.body.includes('"attest"'),
    );
    expect(refused).toHaveLength(1); // the stale one; the fresh bundle showed the new identity
    expect(queuedFor('B', 'attest')).toEqual([]);
    expect(await as('A', (app) => app.signal.getPendingIdentityChange(USERS.B.id))).toMatchObject({
      peerUserId: USERS.B.id,
    });

    // Until A reviews the new code: A cannot call B, and B's call to A cannot be answered.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const placed = server.calls.size;
    await as('A', (app) => app.calls.startCall(USERS.B.id));
    expect(callState('A')).toMatchObject({ phase: 'ended', endReason: 'identity_changed' });
    expect(server.calls.size).toBe(placed); // nothing reached the server
    await as('A', async (app) => app.calls.dismissEndedCall());

    await deliver('B'); // B learns that A's call ended
    await until('B', () => callState('B').phase !== 'connecting', 'B out of the call');
    await as('B', (app) => app.calls.startCall(USERS.A.id));
    await deliver('A');
    await until('A', () => callState('A').identityChanged === true, 'notice shown');
    expect(callState('A').phase).toBe('incoming');
    await as('A', (app) => app.calls.answerCall());
    expect(callState('A').phase).toBe('incoming');
    const accepts = server.requests.filter((r) => /\/calls\/[\w-]+\/accept$/.test(r.path));
    expect(accepts).toHaveLength(1); // only B's earlier answer: A's answer was blocked
  });
});
