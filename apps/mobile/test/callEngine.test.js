/* global jest */
import { loadApp, mockApi, resetDevice, signIn, USER } from './helpers';

/**
 * Voice-call engine on the phone: signaling flows, state machine, timeouts, recovery, cleanup,
 * Chat Lock and notifications. WebRTC itself is a FAKE here (no audio, no network): these
 * tests prove the engine's logic, not that two phones can talk. Real audio, STUN/TURN and
 * network switching can only be verified on physical devices.
 */
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  Stack: { Screen: () => null },
  usePathname: () => '/',
  useLocalSearchParams: () => globalThis.__routeParams ?? {},
  // Rendered screens are always focused in these tests.
  useFocusEffect: (effect) => require('react').useEffect(() => effect(), [effect]),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/**
 * Call security (R2) in these tests: there is one phone and no real peer, so the Signal layer
 * is a TEST DOUBLE here — "sealing" just encodes the attestation content and "opening" decodes
 * it — and a fake SDP without fingerprint lines stands for one fixed fingerprint
 * (mockFingerprint). The engine's logic (holding, verifying, binding, failing closed) runs for
 * real; the real Signal encryption, real fingerprint parsing and two phones are tested in
 * callSecurity.test.js.
 */
const mockFingerprint = `sha-256 ${Array(32).fill('5A').join(':')}`;
jest.mock('../src/crypto/signalService', () => ({
  ...jest.requireActual('../src/crypto/signalService'),
  sealForPeer: jest.fn(async (_me, _peer, bytes) => ({
    type: 2,
    body: Buffer.from(bytes).toString('base64'),
    recipientRegistrationId: 4242,
  })),
  openFromPeer: jest.fn(async (_me, _sender, { body }) =>
    require('../src/messaging/content').decodeContent(new Uint8Array(Buffer.from(body, 'base64'))),
  ),
}));
jest.mock('../src/calls/callSecurity', () => {
  const actual = jest.requireActual('../src/calls/callSecurity');
  return {
    ...actual,
    parseFingerprints: (sdp) =>
      typeof sdp === 'string' && !/a=fingerprint/i.test(sdp)
        ? { ok: true, fingerprints: [mockFingerprint] }
        : actual.parseFingerprints(sdp),
  };
});

jest.mock('../src/calls/media', () => {
  const state = { pcs: [], streams: [], micError: null, route: null };
  class FakePeerConnection {
    constructor(iceServers, options = {}) {
      this.iceServers = iceServers;
      this.options = options;
      this.listeners = {};
      this.signalingState = 'stable';
      this.localDescription = null;
      this.connectionState = 'new';
      this.tracks = [];
      this.remoteDescription = null;
      this.remoteDescriptionCalls = 0;
      this.addedCandidates = [];
      this.offers = 0;
      this.closed = false;
      this.failNextOffer = false;
      state.pcs.push(this);
    }
    addEventListener(event, handler) {
      (this.listeners[event] ??= new Set()).add(handler);
    }
    removeEventListener(event, handler) {
      this.listeners[event]?.delete(handler);
    }
    emit(event, value) {
      for (const handler of this.listeners[event] ?? []) handler(value);
    }
    listenerCount() {
      return Object.values(this.listeners).reduce((n, set) => n + set.size, 0);
    }
    addTrack(track) {
      this.tracks.push(track);
      const sender = {
        track,
        replaced: [],
        async replaceTrack(next) {
          sender.replaced.push(next);
          sender.track = next;
        },
      };
      (this.senders ??= []).push(sender);
      return sender;
    }
    async createOffer() {
      if (this.failNextOffer) throw new Error('createOffer failed');
      this.offers += 1;
      return { type: 'offer', sdp: `v=0 offer ${this.offers}` };
    }
    async createAnswer() {
      return { type: 'answer', sdp: 'v=0 answer' };
    }
    async setLocalDescription(description) {
      this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
      this.localDescription = { ...description };
    }
    // Like react-native-webrtc: the local description is refreshed (with the candidates
    // gathered so far) as gathering progresses.
    gathered(line) {
      if (this.localDescription) {
        this.localDescription = {
          ...this.localDescription,
          sdp: `${this.localDescription.sdp}\r\na=${line}`,
        };
      }
    }
    async setRemoteDescription(description) {
      this.remoteDescriptionCalls += 1;
      this.remoteDescription = description;
      this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    async addIceCandidate(candidate) {
      this.addedCandidates.push(candidate);
    }
    restartIce() {
      this.restarted = true;
    }
    close() {
      this.closed = true;
      this.connectionState = 'closed';
    }
    setConnectionState(value) {
      this.connectionState = value;
      this.emit('connectionstatechange', {});
    }
  }
  const makeTrack = (kind) => ({
    kind,
    enabled: true,
    stopped: false,
    switches: 0,
    stop() {
      this.stopped = true;
    },
    _switchCamera() {
      if (state.singleCamera) throw new Error('no other camera');
      this.switches += 1;
    },
  });
  const makeStream = ({ audio = true, video = false } = {}) => {
    const tracks = [];
    if (audio) tracks.push(makeTrack('audio'));
    if (video) tracks.push(makeTrack('video'));
    const url = `stream-${state.streams.length + 1}`;
    const stream = {
      track: tracks.find((t) => t.kind === 'audio') ?? null,
      videoTrack: tracks.find((t) => t.kind === 'video') ?? null,
      getTracks: () => tracks.slice(),
      getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
      getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
      removeTrack: (track) => {
        const i = tracks.indexOf(track);
        if (i !== -1) tracks.splice(i, 1);
      },
      toURL: () => url,
    };
    state.streams.push(stream);
    return stream;
  };
  const getMicrophone = jest.fn(async () => {
    if (state.micError) throw state.micError;
    return makeStream();
  });
  return {
    __state: state,
    getMicrophone,
    getMedia: jest.fn(async ({ audio = true, video = false } = {}) => {
      if (!video) return getMicrophone();
      if (audio && state.micError) throw state.micError;
      if (state.cameraError) throw state.cameraError;
      return makeStream({ audio, video: true });
    }),
    switchCamera: jest.fn((track, current) => {
      try {
        track._switchCamera();
        return current === 'user' ? 'environment' : 'user';
      } catch {
        return null;
      }
    }),
    createPeerConnection: jest.fn(
      (iceServers, options) => new FakePeerConnection(iceServers, options),
    ),
    // What the real getStats() classification would report; `route` set per test.
    getConnectionRoute: jest.fn(async () => (state.route ? { route: state.route } : null)),
    toIceCandidate: (init) => ({ ...init }),
    toSessionDescription: (init) => ({ ...init }),
    audio: {
      start: jest.fn(),
      stop: jest.fn(),
      setSpeaker: jest.fn(),
      startRingtone: jest.fn(),
      stopRingtone: jest.fn(),
    },
    keepAlive: {
      start: jest.fn(() => true),
      stop: jest.fn(),
    },
  };
});

const PEER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CALL_ID = '11111111-1111-4111-8111-111111111111';
const CREATED = '2026-01-01T00:00:00.000Z';
const EXPIRES = '2026-01-01T00:00:45.000Z';
const ICE = [{ urls: ['stun:stun.example'] }];

let app;
let engine;
let media;
let server;

const store = () => engine.useCallStore.getState();
const pc = () => media.__state.pcs.at(-1);
const callView = (role, status = 'ringing') => ({
  callId: CALL_ID,
  role,
  peerUserId: PEER,
  status,
  createdAt: CREATED,
  ringExpiresAt: EXPIRES,
});
const PEER_DEVICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/**
 * The peer's attestation for the call on screen, as its phone would send it (through the test
 * double above): the right call, role, people and kind, and the fixed fingerprint.
 */
function peerAttestation(callId = store().callId ?? CALL_ID, fields = {}) {
  const content = {
    type: 'call.dtls',
    version: 1,
    callId,
    role: store().direction === 'outgoing' ? 'callee' : 'caller',
    from: PEER,
    to: USER.id,
    kind: store().kind,
    fingerprints: [mockFingerprint],
    ...fields,
  };
  const bytes = require('../src/messaging/content').encodeContent(content);
  return { type: 2, body: Buffer.from(bytes).toString('base64') };
}
const attest = (attestation = peerAttestation(), callId = CALL_ID) =>
  engine.handleCallEvent({
    type: 'signal',
    callId,
    kind: 'attest',
    attestation,
    senderDeviceId: PEER_DEVICE,
  });

/**
 * A call event from the server. Like the peer's phone, which sends its attestation ahead of
 * every offer and answer, an offer or answer here is preceded by the peer's attestation (the
 * same bytes each time; the engine ignores copies once verified) unless `{ attested: false }`.
 */
const event = (payload, { attested = true } = {}) => {
  const description = payload.type === 'signal' && ['offer', 'answer'].includes(payload.kind);
  if (description && attested) attest(peerAttestation(payload.callId ?? CALL_ID), payload.callId);
  return engine.handleCallEvent({ callId: CALL_ID, ...payload });
};
const invite = () =>
  event({ type: 'invite', callerUserId: PEER, createdAt: CREATED, ringExpiresAt: EXPIRES });
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const requests = (key) => server.calls.filter((c) => c.key === key);
const ends = () => requests(`POST /calls/${CALL_ID}/end`).map((c) => c.body);
const allSignals = () => requests(`POST /calls/${CALL_ID}/signal`).map((c) => c.body);
/** Signaling sent, without our attestations (tested on their own). */
const signals = () => allSignals().filter((body) => body.kind !== 'attest');
const attestationsSent = () => allSignals().filter((body) => body.kind === 'attest');
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/**
 * What GET /calls/current answers when a test does not say: the server agrees with the phone
 * (its call ringing or answered, nothing lost). Tests of lost or stale events set
 * `server.current` (null = no call) themselves.
 */
function serverViewOfPhoneCall() {
  const { callId, direction, phase } = engine.useCallStore.getState();
  if (!callId || phase === 'idle' || phase === 'ended') return null;
  const ringing = phase === 'outgoing' || phase === 'incoming';
  return {
    ...callView(direction === 'outgoing' ? 'caller' : 'callee', ringing ? 'ringing' : 'accepted'),
    callId,
  };
}

function createCallServer() {
  const s = { current: undefined, start: null, accept: null, missed: [] };
  const startResponse = () => ({
    status: 201,
    body: { call: callView('caller'), iceServers: ICE },
  });
  const acceptResponse = () => ({
    body: { call: callView('callee', 'accepted'), iceServers: ICE },
  });
  s.startResponse = startResponse;
  s.acceptResponse = acceptResponse;
  s.calls = mockApi({
    'POST /calls': () => s.start ?? startResponse(),
    [`POST /calls/${CALL_ID}/accept`]: () => s.accept ?? acceptResponse(),
    [`POST /calls/${CALL_ID}/reject`]: () => ({ status: 204 }),
    [`POST /calls/${CALL_ID}/signal`]: () => ({ status: 204 }),
    [`POST /calls/${CALL_ID}/end`]: () => ({ status: 204 }),
    'GET /calls/current': () => ({
      body: { call: s.current === undefined ? serverViewOfPhoneCall() : s.current },
    }),
    'GET /calls/missed': () => ({ body: { missed: s.missed } }),
    'POST /calls/missed/ack': () => ({ status: 204 }),
    'POST /contacts/match': () => ({ body: { matches: s.contactMatches ?? [] } }),
    [`GET /presence?userIds=${PEER}`]: () => ({ body: { presence: { [PEER]: false } } }),
    'POST /auth/logout': () => ({ status: 204 }),
    'DELETE /account': () => ({ status: 204 }),
  });
  return s;
}

/** Outgoing call up to "connected". */
async function connectedOutgoingCall() {
  await engine.startCall(PEER);
  event({ type: 'accepted' });
  await flush();
  event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' });
  await flush();
  pc().setConnectionState('connected');
}

beforeEach(async () => {
  jest.resetModules();
  resetDevice();
  app = loadApp();
  await signIn(app);
  engine = require('../src/calls/callEngine');
  media = require('../src/calls/media');
  server = createCallServer();
});

afterEach(() => {
  jest.useRealTimers();
  engine.endCallForSignOut();
});

describe('outgoing call', () => {
  it('rings, negotiates over signaling, connects, hangs up and releases everything', async () => {
    await engine.startCall(PEER);
    expect(store()).toMatchObject({
      phase: 'outgoing',
      callId: CALL_ID,
      peerUserId: PEER,
      direction: 'outgoing',
    });
    expect(requests('POST /calls')[0].body).toEqual({ calleeUserId: PEER, kind: 'voice' });
    expect(media.getMicrophone).toHaveBeenCalledTimes(1);
    // The call holds the microphone: keep it working if the user leaves the app.
    expect(media.keepAlive.start).toHaveBeenCalledTimes(1);
    expect(media.__state.pcs).toHaveLength(0); // no peer connection until answered

    event({ type: 'accepted' });
    await flush();
    expect(store().phase).toBe('connecting');
    expect(pc().iceServers).toEqual(ICE);
    expect(pc().tracks).toHaveLength(1);
    expect(signals()).toEqual([{ kind: 'offer', sdp: 'v=0 offer 1' }]);
    expect(media.audio.start).toHaveBeenCalled();

    // Remote candidates before the answer wait; the answer releases them.
    event({
      type: 'signal',
      kind: 'candidates',
      candidates: [{ candidate: 'cand-remote-1', sdpMid: '0', sdpMLineIndex: 0 }],
    });
    await flush();
    expect(pc().addedCandidates).toEqual([]);
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' });
    await flush();
    expect(pc().remoteDescription).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    expect(pc().addedCandidates.map((c) => c.candidate)).toEqual(['cand-remote-1']);

    // Local candidates are batched into one request, without duplicates.
    const local = (candidate) => ({ candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 } });
    pc().emit('icecandidate', local('cand-local-1'));
    pc().emit('icecandidate', local('cand-local-1'));
    pc().emit('icecandidate', local('cand-local-2'));
    pc().emit('icecandidate', { candidate: null }); // gathering finished
    await new Promise((resolve) => setTimeout(resolve, 200));
    await flush();
    expect(signals().filter((s) => s.kind === 'candidates')).toEqual([
      {
        kind: 'candidates',
        candidates: [
          { candidate: 'cand-local-1', sdpMid: '0', sdpMLineIndex: 0 },
          { candidate: 'cand-local-2', sdpMid: '0', sdpMLineIndex: 0 },
        ],
      },
    ]);

    pc().setConnectionState('connected');
    expect(store()).toMatchObject({ phase: 'connected', connectedAt: expect.any(Number) });

    const connection = pc();
    const { track } = media.__state.streams[0];
    engine.hangUp();
    engine.hangUp(); // twice: harmless
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'hangup' });
    expect(ends()).toEqual([{ reason: 'hangup' }]);
    expect(connection.closed).toBe(true);
    expect(connection.listenerCount()).toBe(0);
    expect(track.stopped).toBe(true);
    expect(media.audio.stop).toHaveBeenCalled();
    expect(media.keepAlive.stop).toHaveBeenCalled();
  });

  it('maps start failures (busy, already in a call, unavailable, offline) and frees the microphone', async () => {
    const cases = [
      [{ status: 409, body: { error: { code: 'CALLEE_BUSY' } } }, 'busy'],
      [{ status: 409, body: { error: { code: 'ALREADY_IN_CALL' } } }, 'already_in_call'],
      [{ status: 404, body: { error: { code: 'CALLEE_UNAVAILABLE' } } }, 'unavailable'],
      [{ status: 500, body: { error: { code: 'INTERNAL_ERROR' } } }, 'failed'],
    ];
    for (const [response, reason] of cases) {
      server.start = response;
      await engine.startCall(PEER);
      expect([reason, store().phase, store().endReason]).toEqual([reason, 'ended', reason]);
      expect(media.__state.streams.at(-1).track.stopped).toBe(true);
      engine.endCallForSignOut();
    }
    server.start = Promise.reject(new TypeError('Network request failed'));
    server.start.catch(() => {});
    await engine.startCall(PEER);
    expect(store().endReason).toBe('failed');
    expect(media.__state.pcs).toHaveLength(0);
  });

  it('microphone permission denied: nothing is started on the server', async () => {
    media.__state.micError = Object.assign(new Error('denied'), { code: 'MIC_PERMISSION_DENIED' });
    await engine.startCall(PEER);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'permission_denied' });
    expect(requests('POST /calls')).toHaveLength(0);
    expect(media.keepAlive.start).not.toHaveBeenCalled();
  });

  it('a refused permission stays explained until closed (or a while), and says if only Settings helps', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const denied = (blocked) =>
      Object.assign(new Error('denied'), { code: 'MIC_PERMISSION_DENIED', blocked });

    media.__state.micError = denied(true); // "Don't allow" for good: the system won't ask again
    await engine.startCall(PEER);
    expect(store()).toMatchObject({ phase: 'ended', permissionBlocked: true });
    // Not gone after the usual 2.5 s: there is something to do.
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ENDED_DISPLAY_MS + 100);
    expect(store().phase).toBe('ended');
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.PERMISSION_NOTICE_MS);
    expect(store().phase).toBe('idle');

    media.__state.micError = denied(false); // dismissed or "Don't allow" once: it may ask again
    await engine.startCall(PEER);
    expect(store()).toMatchObject({ phase: 'ended', permissionBlocked: false });
    engine.dismissEndedCall(); // Close
    expect(store()).toMatchObject({ phase: 'idle', permissionBlocked: false });
    // Nothing ever reached the server, and the microphone was never kept alive.
    expect(requests('POST /calls')).toHaveLength(0);
    expect(media.keepAlive.start).not.toHaveBeenCalled();

    // Other endings still close quickly.
    media.__state.micError = null;
    await engine.startCall(PEER);
    engine.hangUp();
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ENDED_DISPLAY_MS + 100);
    expect(store().phase).toBe('idle');
  });

  it('call screen: a refused microphone offers Open Settings and Close', async () => {
    const React = require('react');
    const { act, create } = require('react-test-renderer');
    const { Linking } = require('react-native');
    Linking.openSettings = jest.fn(async () => {});
    media.__state.micError = Object.assign(new Error('denied'), {
      code: 'MIC_PERMISSION_DENIED',
      blocked: true,
    });
    await engine.startCall(PEER);
    const Screen = require('../src/app/(app)/call').default;
    let tree;
    await act(async () => {
      tree = create(React.createElement(Screen));
    });
    const text = (id) => tree.root.findByProps({ testID: id }).props.children;
    expect(text('call-status')).toBe('Microphone permission is needed for calls');
    expect(text('permission-hint')).toMatch(/turn it on in Settings/);
    await act(async () => tree.root.findByProps({ testID: 'call-open-settings' }).props.onPress());
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    expect(store().phase).toBe('idle'); // the screen closes behind Settings
    await act(async () => tree.unmount());

    // Close, without Settings.
    await engine.startCall(PEER);
    await act(async () => {
      tree = create(React.createElement(Screen));
    });
    await act(async () => tree.root.findByProps({ testID: 'call-close' }).props.onPress());
    expect(store().phase).toBe('idle');
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  });

  it('cannot start a second call while one is active', async () => {
    await engine.startCall(PEER);
    expect(await engine.startCall('cccccccccccccccccccccccc')).toBe(false);
    expect(requests('POST /calls')).toHaveLength(1);
  });

  it('an "accepted" that overtakes the POST /calls response is applied once it returns', async () => {
    const response = defer();
    server.start = response.promise;
    const starting = engine.startCall(PEER);
    await flush();
    event({ type: 'accepted' }); // Pusher was faster than our HTTP response
    response.resolve(server.startResponse());
    await starting;
    await flush();
    expect(store().phase).toBe('connecting');
    expect(signals()).toEqual([{ kind: 'offer', sdp: 'v=0 offer 1' }]);
  });

  it('hanging up while the call is being created still ends it on the server', async () => {
    const response = defer();
    server.start = response.promise;
    const starting = engine.startCall(PEER);
    await flush();
    engine.hangUp();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'hangup' });
    response.resolve(server.startResponse());
    await starting;
    await flush();
    expect(ends()).toEqual([{ reason: 'hangup' }]);
    expect(media.__state.streams[0].track.stopped).toBe(true);
  });
});

describe('incoming call', () => {
  it('rings, answers, applies an offer that arrived early, and connects', async () => {
    invite();
    expect(store()).toMatchObject({
      phase: 'incoming',
      callId: CALL_ID,
      peerUserId: PEER,
      direction: 'incoming',
    });
    expect(media.audio.startRingtone).toHaveBeenCalledTimes(1);
    expect(media.getMicrophone).not.toHaveBeenCalled(); // no microphone before answering
    expect(media.keepAlive.start).not.toHaveBeenCalled();

    const accept = defer();
    server.accept = accept.promise;
    const answering = engine.answerCall();
    await flush();
    expect(store().phase).toBe('answering');
    expect(media.audio.stopRingtone).toHaveBeenCalled();
    expect(media.keepAlive.start).toHaveBeenCalledTimes(1);
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' }); // caller faster than our HTTP
    accept.resolve(server.acceptResponse());
    await answering;
    await flush();

    expect(store().phase).toBe('connecting');
    expect(pc().remoteDescription).toEqual({ type: 'offer', sdp: 'v=0 offer 1' });
    expect(signals()).toEqual([{ kind: 'answer', sdp: 'v=0 answer' }]);
    pc().setConnectionState('connected');
    expect(store().phase).toBe('connected');
  });

  it('declining tells the server and never touches the microphone', async () => {
    invite();
    engine.declineCall();
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'declined' });
    expect(requests(`POST /calls/${CALL_ID}/reject`)).toHaveLength(1);
    expect(media.getMicrophone).not.toHaveBeenCalled();
    expect(media.keepAlive.start).not.toHaveBeenCalled();
    expect(media.audio.stopRingtone).toHaveBeenCalled();
    expect(media.__state.pcs).toHaveLength(0);
  });

  it('microphone denied while answering ends the call for the caller too', async () => {
    invite();
    media.__state.micError = Object.assign(new Error('denied'), { code: 'MIC_PERMISSION_DENIED' });
    await engine.answerCall();
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'permission_denied' });
    expect(ends()).toEqual([{ reason: 'failed' }]);
    expect(requests(`POST /calls/${CALL_ID}/accept`)).toHaveLength(0);
  });

  it('answering a call the caller just cancelled shows a missed call', async () => {
    invite();
    server.accept = { status: 409, body: { error: { code: 'CALL_ENDED' } } };
    await engine.answerCall();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'missed' });
    expect(media.__state.streams[0].track.stopped).toBe(true);
  });
});

describe('remote endings', () => {
  it('maps what the other side did to what this phone shows', async () => {
    // While it still rings for us (the server says why it ended).
    const outgoing = [
      [{ status: 'rejected', reason: 'rejected' }, 'rejected'], // they declined
      [{ status: 'missed', reason: 'no_answer' }, 'missed'], // rang out
      [{ status: 'ended', reason: 'hangup' }, 'remote_hangup'],
      // Their phone could not take the call (e.g. no microphone): not "declined".
      [{ status: 'failed', reason: 'failed' }, 'unavailable'],
      // The same, from a server that still reports it as rejected.
      [{ status: 'rejected', reason: 'failed' }, 'unavailable'],
    ];
    for (const [ending, reason] of outgoing) {
      await engine.startCall(PEER);
      event({ type: 'ended', ...ending });
      expect([ending, store().endReason]).toEqual([ending, reason]);
      engine.endCallForSignOut();
    }
    // A new call (CALL_ID is finished now: it would never ring again).
    const callId = '44444444-4444-4444-8444-444444444444';
    engine.handleCallEvent({
      type: 'invite',
      callId,
      callerUserId: PEER,
      createdAt: CREATED,
      ringExpiresAt: EXPIRES,
    });
    expect(store().phase).toBe('incoming');
    engine.handleCallEvent({ type: 'ended', callId, status: 'cancelled' });
    expect(store().endReason).toBe('missed'); // the caller gave up: a missed call for us
    // The server announced every one of these endings: nothing is ever sent back for them.
    expect(server.calls.filter((c) => c.key.endsWith('/end'))).toEqual([]);
  });

  it('a failure reported by the other side reads by how far the call got', () => {
    const { remoteEndReason } = engine;
    expect(remoteEndReason('failed', 'failed', 'outgoing')).toBe('unavailable');
    expect(remoteEndReason('failed', 'failed', 'connecting')).toBe('failed');
    expect(remoteEndReason('failed', 'connection_lost', 'connected')).toBe('connection_lost');
    expect(remoteEndReason('failed', 'connection_lost', 'reconnecting')).toBe('connection_lost');
    expect(remoteEndReason('rejected', 'rejected', 'outgoing')).toBe('rejected');
    expect(remoteEndReason('cancelled', 'hangup', 'incoming')).toBe('missed');
    expect(remoteEndReason('something-new', undefined, 'connected')).toBe('remote_hangup');
  });

  it('their phone failing to take our call goes into the history as unavailable, not declined', async () => {
    await engine.startCall(PEER);
    event({ type: 'ended', status: 'failed', reason: 'failed' });
    await flush();
    const [entry] = await require('../src/calls/callHistory').listCallLog();
    expect(entry).toMatchObject({ direction: 'out', outcome: 'unavailable' });
  });
});

describe('initial signaling recovery (lost events and failed requests)', () => {
  const T = () => engine.CALL_TIMEOUTS;
  const offersSent = () => signals().filter((sig) => sig.kind === 'offer');
  const answersSent = () => signals().filter((sig) => sig.kind === 'answer');
  const fakeTimers = () => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  /** Makes POST /signal requests of `kind` fail with no response while `down()` is true. */
  function signalRequestsFail(kind, down, { status } = {}) {
    const serverFetch = global.fetch;
    const attempts = [];
    global.fetch = jest.fn(async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (url.endsWith('/signal') && body?.kind === kind) {
        attempts.push(body);
        if (down()) {
          if (status) {
            return {
              status,
              json: async () => ({ error: { code: 'CALL_ENDED', message: 'ended' } }),
              headers: { get: () => null },
            };
          }
          throw new TypeError('Network request failed');
        }
      }
      return serverFetch(url, init);
    });
    return attempts;
  }
  async function acceptedOutgoingCall() {
    await engine.startCall(PEER);
    event({ type: 'accepted' });
    await flush();
  }

  it('caller: a lost first offer is sent again (same offer, next number) until answered', async () => {
    fakeTimers();
    await acceptedOutgoingCall();
    expect(offersSent()).toEqual([{ kind: 'offer', sdp: 'v=0 offer 1' }]);
    pc().gathered('candidate:1 1 udp 1 192.0.2.1 50001 typ host'); // gathered meanwhile

    await jest.advanceTimersByTimeAsync(T().RESTART_ANSWER_MS);
    expect(offersSent()).toHaveLength(2);
    // The same local offer (now with its candidates), not a new one: nothing renegotiated.
    expect(offersSent()[1]).toEqual({ kind: 'offer', sdp: pc().localDescription.sdp, restart: 1 });
    expect(offersSent()[1].sdp).toContain('a=candidate:1');
    expect(pc().offers).toBe(1); // createOffer ran once
    expect(pc().signalingState).toBe('have-local-offer');

    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer', restart: 1 });
    await flush();
    pc().setConnectionState('connected');
    expect(store().phase).toBe('connected');
    await jest.advanceTimersByTimeAsync(T().RESTART_ANSWER_MS * 3);
    expect(offersSent()).toHaveLength(2); // answered: never sent again
  });

  it('caller: a lost answer — a late answer to an older copy is ignored, the latest applies once', async () => {
    fakeTimers();
    await acceptedOutgoingCall();
    await jest.advanceTimersByTimeAsync(T().RESTART_ANSWER_MS); // copy 1 sent
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer to copy 0' }); // late, to copy 0
    await flush();
    expect(pc().remoteDescriptionCalls).toBe(0);
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer to copy 1', restart: 1 });
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer to copy 1', restart: 1 }); // dup
    await flush();
    expect(pc().remoteDescriptionCalls).toBe(1);
    expect(pc().remoteDescription).toEqual({ type: 'answer', sdp: 'v=0 answer to copy 1' });
  });

  it('caller: no copy is sent once answered quickly', async () => {
    fakeTimers();
    await acceptedOutgoingCall();
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' });
    await flush();
    await jest.advanceTimersByTimeAsync(T().RESTART_ANSWER_MS * 4);
    expect(offersSent()).toHaveLength(1);
  });

  it('caller: copies stop at the negotiation deadline, which ends the attempt as failed', async () => {
    fakeTimers();
    await acceptedOutgoingCall();
    await jest.advanceTimersByTimeAsync(T().NEGOTIATION_MS + 10);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'failed' });
    const sent = offersSent().length;
    expect(sent).toBeGreaterThan(1);
    expect(sent).toBeLessThanOrEqual(1 + Math.ceil(T().NEGOTIATION_MS / T().RESTART_ANSWER_MS));
    await jest.advanceTimersByTimeAsync(T().NEGOTIATION_MS);
    expect(offersSent()).toHaveLength(sent);
    expect(ends()).toEqual([{ reason: 'failed' }]);
  });

  it('caller: an offer request with no response is retried (2 s, then 4 s), not fatal', async () => {
    fakeTimers();
    let down = true;
    const attempts = signalRequestsFail('offer', () => down);
    await acceptedOutgoingCall();
    expect(attempts).toHaveLength(1);
    expect(store().phase).toBe('connecting'); // not "Call failed"
    await jest.advanceTimersByTimeAsync(T().SIGNAL_RETRY_MS[0]);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ restart: 1 });
    down = false;
    await jest.advanceTimersByTimeAsync(T().SIGNAL_RETRY_MS[1] - 1);
    expect(attempts).toHaveLength(2); // backoff: the second retry waits 4 s
    await jest.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(3);
    expect(offersSent()).toEqual([{ kind: 'offer', sdp: 'v=0 offer 1', restart: 2 }]);
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer', restart: 2 });
    await flush();
    pc().setConnectionState('connected');
    expect(store().phase).toBe('connected');
    expect(ends()).toEqual([]);
  });

  it('caller: a server rejection of the offer is final (no retry)', async () => {
    fakeTimers();
    const attempts = signalRequestsFail('offer', () => true, { status: 409 });
    await acceptedOutgoingCall();
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'failed' });
    await jest.advanceTimersByTimeAsync(T().NEGOTIATION_MS);
    expect(attempts).toHaveLength(1);
  });

  async function answeringCallee() {
    invite();
    await engine.answerCall();
    await flush();
  }

  it('callee: an answer request with no response is re-sent (same number); the call goes on', async () => {
    fakeTimers();
    let down = true;
    const attempts = signalRequestsFail('answer', () => down);
    await answeringCallee();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush();
    expect(attempts).toHaveLength(1);
    expect(store().phase).toBe('connecting'); // not ended
    down = false;
    await jest.advanceTimersByTimeAsync(T().SIGNAL_RETRY_MS[0]);
    expect(attempts).toHaveLength(2);
    expect(answersSent()).toEqual([{ kind: 'answer', sdp: 'v=0 answer' }]); // no number: copy 0
    expect(ends()).toEqual([]);
    pc().setConnectionState('connected');
    await jest.advanceTimersByTimeAsync(T().SIGNAL_RETRY_MS[1] * 3);
    expect(attempts).toHaveLength(2); // connected: never re-sent
  });

  it('callee: a pending answer retry is dropped once a newer offer copy arrived', async () => {
    fakeTimers();
    let down = true;
    const attempts = signalRequestsFail('answer', () => down);
    await answeringCallee();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush(); // answer to copy 0 failed; its retry is pending
    down = false;
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1', restart: 1 });
    await flush();
    await jest.advanceTimersByTimeAsync(T().SIGNAL_RETRY_MS[1] * 2);
    // Only the answer to copy 1 went out: the stale answer to copy 0 was never re-sent.
    expect(answersSent()).toEqual([{ kind: 'answer', sdp: 'v=0 answer', restart: 1 }]);
    expect(attempts.map((a) => a.restart ?? 0)).toEqual([0, 1]);
  });

  it('callee: a server rejection of the answer is final (no retry)', async () => {
    fakeTimers();
    const attempts = signalRequestsFail('answer', () => true, { status: 409 });
    await answeringCallee();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'failed' });
    await jest.advanceTimersByTimeAsync(T().NEGOTIATION_MS);
    expect(attempts).toHaveLength(1);
  });

  it('callee: answers that never get a response stop at the negotiation deadline', async () => {
    fakeTimers();
    const attempts = signalRequestsFail('answer', () => true); // never a response
    await answeringCallee();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush();
    await jest.advanceTimersByTimeAsync(T().NEGOTIATION_MS + 10);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'failed' });
    const tries = attempts.length;
    expect(tries).toBeGreaterThan(1); // it did retry
    expect(tries).toBeLessThanOrEqual(1 + Math.ceil(T().NEGOTIATION_MS / T().SIGNAL_RETRY_MS[0]));
    await jest.advanceTimersByTimeAsync(T().NEGOTIATION_MS);
    expect(attempts).toHaveLength(tries); // and stopped with the call
  });

  it('caller: a lost "accepted" is picked up by the ringing check', async () => {
    fakeTimers();
    await engine.startCall(PEER);
    server.current = callView('caller', 'accepted'); // the callee answered; the event was lost
    await jest.advanceTimersByTimeAsync(T().RING_CHECK_MS);
    await flush();
    expect(store().phase).toBe('connecting');
    expect(offersSent()).toHaveLength(1);
  });

  it('callee: a lost "ended" (the caller gave up) stops the ringing within one check', async () => {
    fakeTimers();
    invite();
    server.current = null;
    await jest.advanceTimersByTimeAsync(T().RING_CHECK_MS);
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'missed' });
  });

  it('ringing checks run only while ringing, one at a time, and stop on every ending', async () => {
    fakeTimers();
    const checks = () => requests('GET /calls/current').length;
    await engine.startCall(PEER);
    await jest.advanceTimersByTimeAsync(T().RING_CHECK_MS * 3);
    expect(checks()).toBe(3);
    event({ type: 'accepted' }); // answered: no more checks
    await flush();
    await jest.advanceTimersByTimeAsync(T().RING_CHECK_MS * 3);
    expect(checks()).toBe(3);
    engine.hangUp();
    await jest.advanceTimersByTimeAsync(T().ENDED_DISPLAY_MS + 100);

    // Declined, timed out, signed out: no checks after any of them.
    const next = (n) => `7777777${n}-7777-4777-8777-777777777777`;
    const ringAgain = (n) =>
      engine.handleCallEvent({
        type: 'invite',
        callId: next(n),
        callerUserId: PEER,
        createdAt: CREATED,
        ringExpiresAt: EXPIRES,
      });
    ringAgain(1);
    engine.declineCall();
    ringAgain(2);
    engine.endCallForSignOut();
    const before = checks();
    await jest.advanceTimersByTimeAsync(T().RING_CHECK_MS * 3);
    expect(checks()).toBe(before);

    // A slow check: the next one waits for it (never two at once).
    const serverFetch = global.fetch;
    const slow = defer();
    let inFlight = 0;
    let most = 0;
    global.fetch = jest.fn(async (url, init) => {
      if (url.endsWith('/calls/current')) {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await slow.promise;
        inFlight -= 1;
      }
      return serverFetch(url, init);
    });
    ringAgain(3);
    await jest.advanceTimersByTimeAsync(T().RING_CHECK_MS * 4);
    expect(most).toBe(1);
    slow.resolve();
    await flush();
    expect(store().phase).toBe('incoming'); // the server agrees: still ringing
  });

  it('a ringing check never revives a finished call', async () => {
    fakeTimers();
    await engine.startCall(PEER);
    server.current = callView('caller'); // our hang-up has not landed on the server yet
    engine.hangUp();
    await jest.advanceTimersByTimeAsync(T().RING_CHECK_MS * 3);
    expect(store().phase).toBe('idle');
    await engine.reconcileCall(); // even an explicit read of the stale call
    expect(store().phase).toBe('idle');
  });

  it('callee: a newer call replacing the ringing one (the "ended" was lost) rings instead', async () => {
    fakeTimers();
    invite(); // CALL_ID rings
    const newer = '88888888-8888-4888-8888-888888888888';
    server.current = { ...callView('callee'), callId: newer }; // the caller called again
    await jest.advanceTimersByTimeAsync(T().RING_CHECK_MS);
    await flush();
    expect(store()).toMatchObject({ phase: 'incoming', callId: newer });
    const [old] = await require('../src/calls/callHistory').listCallLog();
    expect(old).toMatchObject({ callId: CALL_ID, outcome: 'missed' });
    expect(ends()).toEqual([]); // nothing ended on the server: it already moved on
  });

  it('foreground incoming-call push: rings only when the server confirms the call', async () => {
    const { onForegroundNotification } = require('../src/notifications/useNotifications');
    const push = (callId) => ({
      request: { content: { data: { type: 'incoming_call', callId } } },
    });
    server.current = null; // a push for a call the server does not have
    onForegroundNotification(push(CALL_ID));
    await flush();
    expect(store().phase).toBe('idle');
    expect(requests('GET /calls/current')).toHaveLength(1);

    server.current = callView('callee'); // invite lost, push arrived: the server confirms
    onForegroundNotification(push(CALL_ID));
    await flush();
    expect(store()).toMatchObject({ phase: 'incoming', callId: CALL_ID, direction: 'incoming' });

    // Message pushes do not touch calls.
    const before = requests('GET /calls/current').length;
    onForegroundNotification({ request: { content: { data: { type: 'message' } } } });
    await flush();
    expect(requests('GET /calls/current')).toHaveLength(before);
  });
});

describe('signaling replay protection', () => {
  const answersSent = () => signals().filter((s) => s.kind === 'answer');

  it('callee: duplicate and stale offers are ignored; each newer restart is answered once', async () => {
    invite();
    await engine.answerCall();
    await flush();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush();
    expect(answersSent()).toHaveLength(1);
    const applied = () => pc().remoteDescriptionCalls;
    const before = applied();

    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' }); // duplicate first offer
    await flush();
    expect([applied(), answersSent().length]).toEqual([before, 1]);

    event({ type: 'signal', kind: 'offer', sdp: 'v=0 restart 2', restart: 2 });
    await flush();
    expect(answersSent()).toHaveLength(2);
    expect(answersSent()[1]).toMatchObject({ restart: 2 });

    // Restart 1 delivered late (after 2), and restart 2 again: neither rolls anything back.
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 restart 1', restart: 1 });
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 restart 2', restart: 2 });
    await flush();
    expect(answersSent()).toHaveLength(2);
    expect(pc().remoteDescription).toEqual({ type: 'offer', sdp: 'v=0 restart 2' });

    // A legitimate re-offer during a reconnect still goes through.
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 restart 3', restart: 3 });
    await flush();
    expect(answersSent()).toHaveLength(3);
    expect(answersSent()[2]).toMatchObject({ restart: 3 });
    expect(store().phase).not.toBe('ended');
  });

  it("an old call's events cannot touch a newer call with the same person", async () => {
    await connectedOutgoingCall(); // CALL_ID
    engine.hangUp();
    await flush();
    const nextCall = '55555555-5555-4555-8555-555555555555';
    server.start = {
      status: 201,
      body: { call: { ...callView('caller'), callId: nextCall }, iceServers: ICE },
    };
    await engine.startCall(PEER);
    engine.handleCallEvent({ type: 'accepted', callId: nextCall });
    await flush();
    const connection = pc();
    const before = {
      phase: store().phase,
      remote: connection.remoteDescriptionCalls,
      added: connection.addedCandidates.length,
    };
    // Replays of the finished call's events (same peer, old call id).
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 old answer' });
    event({
      type: 'signal',
      kind: 'candidates',
      candidates: [{ candidate: 'candidate:77 1 udp 1 192.0.2.77 50077 typ host', sdpMid: '0' }],
    });
    event({ type: 'accepted' });
    event({ type: 'ended', status: 'ended', reason: 'hangup' });
    event({ type: 'invite', callerUserId: PEER, createdAt: CREATED, ringExpiresAt: EXPIRES });
    await flush();
    expect({
      phase: store().phase,
      remote: connection.remoteDescriptionCalls,
      added: connection.addedCandidates.length,
    }).toEqual(before);
    expect(store().callId).toBe(nextCall);
  });
});

describe('a call interrupted by the app being killed', () => {
  const marker = async () => JSON.parse((await app.db.getMeta('calls.inProgress')) ?? 'null');
  const history = () => require('../src/calls/callHistory').listCallLog();

  /** Force-close + relaunch: memory gone, encrypted storage (and its marker) kept. */
  async function relaunch() {
    jest.resetModules();
    app = loadApp();
    await app.auth.useAuthStore.getState().initialize();
    engine = require('../src/calls/callEngine');
    media = require('../src/calls/media');
    server = createCallServer();
  }

  it('a normal ending records the call once and leaves no marker behind', async () => {
    await connectedOutgoingCall();
    await flush();
    expect(await marker()).toMatchObject({
      callId: CALL_ID,
      peerUserId: PEER,
      connectedAt: expect.any(Number),
    });
    engine.hangUp();
    await flush();
    expect(await marker()).toBeNull();
    expect(await engine.recoverInterruptedCall()).toBe(false); // nothing to recover
    const entries = await history();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ callId: CALL_ID, outcome: 'answered' });
  });

  it('killed mid-call: the next start records it once as interrupted, never twice', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    await flush();
    const { connectedAt } = await marker();
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ALIVE_MARK_MS * 2 + 10);
    const { aliveAt } = await marker();
    expect(aliveAt).toBeGreaterThan(connectedAt); // kept current while the call lasts
    jest.useRealTimers();

    await relaunch(); // the process died: no hang-up, no history entry was written
    expect(await history()).toHaveLength(0);
    expect(await engine.recoverInterruptedCall()).toBe(true);
    const entries = await history();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      callId: CALL_ID,
      peerUserId: PEER,
      direction: 'out',
      outcome: 'interrupted',
      connectedAt,
      endedAt: aliveAt,
    });
    expect(await marker()).toBeNull();
    // Running again (another start) adds nothing.
    expect(await engine.recoverInterruptedCall()).toBe(false);
    expect(await history()).toHaveLength(1);
    // A late event for that call never brings it back.
    invite();
    expect(store().phase).toBe('idle');
  });

  it('never marks a call that is still running here as interrupted', async () => {
    await connectedOutgoingCall();
    await flush();
    expect(await engine.recoverInterruptedCall()).toBe(false);
    expect(store().phase).toBe('connected');
    expect(await history()).toHaveLength(0);
    expect(await marker()).toMatchObject({ callId: CALL_ID });
  });

  it('a call that never connected leaves no marker (missed/declined stay as they are)', async () => {
    invite();
    engine.declineCall();
    await flush();
    expect(await marker()).toBeNull();
    const entries = await history();
    expect(entries.map((e) => e.outcome)).toEqual(['declined']);
  });

  it('an interrupted call reads as such in the history', () => {
    const { describeCall } = require('../src/calls/callHistory');
    expect(
      describeCall({ direction: 'out', outcome: 'interrupted', connectedAt: 1, endedAt: 61_000 }),
    ).toMatchObject({ title: 'Voice call', detail: 'Interrupted', missed: false });
  });
});

describe('incoming call alert', () => {
  it('rings (and vibrates) for exactly as long as this phone lets the call ring', () => {
    invite(); // the server's ring window is 45 s
    expect(media.audio.startRingtone).toHaveBeenCalledWith(
      45_000 + engine.CALL_TIMEOUTS.RING_GRACE_MS,
    );
  });
});

describe('timeouts', () => {
  it('an unanswered outgoing call times out as missed and tells the server', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await engine.startCall(PEER);
    await jest.advanceTimersByTimeAsync(45_000 + engine.CALL_TIMEOUTS.RING_GRACE_MS);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'missed' });
    expect(ends()).toEqual([{ reason: 'timeout' }]);
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ENDED_DISPLAY_MS);
    expect(store().phase).toBe('idle');
  });

  it('an incoming call stops ringing on its own if never answered', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    invite();
    await jest.advanceTimersByTimeAsync(45_000 + engine.CALL_TIMEOUTS.RING_GRACE_MS);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'missed' });
    expect(media.audio.stopRingtone).toHaveBeenCalled();
  });

  it('negotiation that never connects fails after the timeout', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await engine.startCall(PEER);
    event({ type: 'accepted' });
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.NEGOTIATION_MS);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'failed' });
    expect(ends()).toEqual([{ reason: 'failed' }]);
    expect(media.__state.pcs[0].closed).toBe(true);
  });

  it('a dropped connection restarts ICE, can recover, and ends if it does not', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    const connection = pc();

    connection.setConnectionState('disconnected');
    expect(store().phase).toBe('reconnecting');
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ICE_RESTART_AFTER_MS);
    expect(connection.restarted).toBe(true);
    expect(signals().filter((s) => s.kind === 'offer')).toHaveLength(2); // restart offer
    connection.setConnectionState('connected');
    expect(store().phase).toBe('connected');
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RECONNECT_MS);
    expect(store().phase).toBe('connected'); // recovery cleared the timer

    connection.setConnectionState('disconnected');
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RECONNECT_MS);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'connection_lost' });
    expect(ends()).toEqual([{ reason: 'connection_lost' }]);
  });

  it('a connection that fails before ever connecting ends the call as failed', async () => {
    await engine.startCall(PEER);
    event({ type: 'accepted' });
    await flush();
    pc().setConnectionState('failed');
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'failed' });
  });

  it('a WebRTC error during negotiation ends the call cleanly', async () => {
    await engine.startCall(PEER);
    const connectionFails = () => {
      media.createPeerConnection.mockImplementationOnce((ice) => {
        const real = jest.requireMock('../src/calls/media');
        const connection = real.createPeerConnection.getMockImplementation()(ice);
        connection.failNextOffer = true;
        return connection;
      });
    };
    connectionFails();
    event({ type: 'accepted' });
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'failed' });
    expect(ends()).toEqual([{ reason: 'failed' }]);
  });
});

describe('duplicate, stale and replayed events', () => {
  it('ignores duplicates and events of other or finished calls', async () => {
    invite();
    invite(); // duplicate
    engine.handleCallEvent({
      type: 'invite',
      callId: '22222222-2222-4222-8222-222222222222',
      callerUserId: 'cccccccccccccccccccccccc',
      createdAt: CREATED,
      ringExpiresAt: EXPIRES,
    }); // a second call while one rings
    expect(media.audio.startRingtone).toHaveBeenCalledTimes(1);
    expect(store().callId).toBe(CALL_ID);

    engine.declineCall();
    engine.endCallForSignOut();
    invite(); // replay of the declined call
    expect(store().phase).toBe('idle');

    for (const garbage of [null, {}, { type: 'invite' }, { callId: 42, type: 'accepted' }]) {
      engine.handleCallEvent(garbage);
    }
    expect(store().phase).toBe('idle');
  });

  it('a duplicate "accepted" sends one offer; a duplicate answer is applied once', async () => {
    await engine.startCall(PEER);
    event({ type: 'accepted' });
    event({ type: 'accepted' });
    engine.handleCallEvent({ type: 'accepted', callId: 'another-call' });
    await flush();
    expect(signals().filter((s) => s.kind === 'offer')).toHaveLength(1);

    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' });
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' });
    await flush();
    expect(pc().remoteDescriptionCalls).toBe(1);

    const candidate = { candidate: 'dup', sdpMid: '0', sdpMLineIndex: 0 };
    event({ type: 'signal', kind: 'candidates', candidates: [candidate, candidate] });
    event({ type: 'signal', kind: 'candidates', candidates: [candidate] });
    await flush();
    expect(pc().addedCandidates).toHaveLength(1);
  });
});

describe('recovery (Pusher reconnect, restart, notification tap)', () => {
  it('shows a ringing call whose invite was missed while Pusher was down', async () => {
    server.current = callView('callee');
    await engine.reconcileCall();
    expect(store()).toMatchObject({ phase: 'incoming', callId: CALL_ID, direction: 'incoming' });
  });

  it('ends a call locally when the server no longer has it', async () => {
    await engine.startCall(PEER);
    server.current = null;
    await engine.reconcileCall();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'remote_hangup' });
  });

  it('continues an outgoing call whose "accepted" event was lost', async () => {
    await engine.startCall(PEER);
    server.current = callView('caller', 'accepted');
    await engine.reconcileCall();
    await flush();
    expect(store().phase).toBe('connecting');
    expect(signals()).toEqual([{ kind: 'offer', sdp: 'v=0 offer 1' }]);
  });

  it('after a crash or force-close, a call the phone was in is ended for both sides', async () => {
    server.current = callView('caller', 'accepted');
    await engine.reconcileCall();
    await flush();
    expect(ends()).toEqual([{ reason: 'failed' }]);
    expect(store().phase).toBe('idle'); // never pretends to resume a dead WebRTC session

    server.current = { ...callView('caller'), callId: CALL_ID };
    await engine.reconcileCall();
    await flush();
    expect(ends()).toEqual([{ reason: 'failed' }, { reason: 'hangup' }]);
  });

  it('a declined call is never revived by a stale server read', async () => {
    invite();
    engine.declineCall();
    engine.endCallForSignOut();
    server.current = callView('callee'); // our reject has not landed yet
    await engine.reconcileCall();
    await flush();
    expect(store().phase).toBe('idle');
    expect(ends()).toEqual([{ reason: 'hangup' }]);
  });

  it('a tapped notification opens the call only while it still rings for this device', async () => {
    server.current = callView('callee');
    expect(await engine.openCallFromNotification(CALL_ID)).toBe(true);
    expect(store().phase).toBe('incoming');
    engine.endCallForSignOut();

    server.current = null; // over, or meant for another account
    expect(await engine.openCallFromNotification('33333333-3333-4333-8333-333333333333')).toBe(
      false,
    );
    expect(store().phase).toBe('idle');
  });

  it('notification routing: a call tap opens the call screen, a stale one does not', async () => {
    const routing = require('../src/notifications/notificationRouting');
    const { router } = require('expo-router');
    const tap = (id) => ({
      notification: {
        request: { identifier: id, content: { data: { type: 'incoming_call', callId: CALL_ID } } },
      },
    });

    server.current = callView('callee');
    expect(routing.captureResponse(tap('n1'))).toBe(true);
    expect(routing.captureResponse(tap('n1'))).toBe(false); // same tap reported twice
    await routing.processPendingTaps();
    expect(router.push).toHaveBeenCalledWith('/call');

    engine.endCallForSignOut();
    router.push.mockClear();
    server.current = null;
    routing.captureResponse(tap('n2'));
    await routing.processPendingTaps();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('the "Incoming voice call" notification is removed once the call is over', async () => {
    globalThis.__device.notify = {
      ...globalThis.__device.notify,
      presented: [
        {
          request: {
            identifier: 'n-call',
            content: { data: { type: 'incoming_call', callId: CALL_ID } },
          },
        },
        { request: { identifier: 'n-msg', content: { data: { type: 'new_message' } } } },
      ],
    };
    invite();
    engine.declineCall();
    await flush();
    expect(globalThis.__device.notify.presented.map((n) => n.request.identifier)).toEqual([
      'n-msg',
    ]);
  });
});

describe('a server read in flight while the call changes (stale reads)', () => {
  const NEWER = '88888888-8888-4888-8888-888888888888';

  /**
   * Holds the next GET /calls/current: the server answers it as things stood when it arrived
   * (e.g. no call yet), but the phone receives that answer only on `release()`, after whatever
   * the test does meanwhile. Like a slow response on a mobile network.
   */
  function holdNextCallRead() {
    const serverFetch = global.fetch;
    const arrived = defer();
    const gate = defer();
    let held = false;
    global.fetch = jest.fn(async (url, init) => {
      if (held || !url.endsWith('/calls/current')) return serverFetch(url, init);
      held = true;
      const response = await serverFetch(url, init);
      arrived.resolve();
      await gate.promise;
      return response;
    });
    return { arrived: arrived.promise, release: () => gate.resolve() };
  }

  it('callee: a call that starts ringing meanwhile is not ended by the read\'s "no call"', async () => {
    const read = holdNextCallRead();
    const reconciling = engine.reconcileCall(); // e.g. Pusher re-subscribed
    await read.arrived; // the server had no call yet
    invite();
    expect(store().phase).toBe('incoming');

    read.release();
    await reconciling;
    await flush();
    expect(store()).toMatchObject({ phase: 'incoming', callId: CALL_ID });
    expect(ends()).toEqual([]);
    expect(await require('../src/calls/callHistory').listCallLog()).toEqual([]);

    // A read that starts after the call rang still applies: the caller gave up, so it is missed.
    server.current = null;
    await engine.reconcileCall();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'missed' });
  });

  it('caller: a call dialled meanwhile is not ended by the read\'s "no call"', async () => {
    const read = holdNextCallRead();
    const reconciling = engine.reconcileCall(); // e.g. the app came to the foreground
    await read.arrived;
    await engine.startCall(PEER);
    expect(store()).toMatchObject({ phase: 'outgoing', callId: CALL_ID });

    read.release();
    await reconciling;
    await flush();
    expect(store()).toMatchObject({ phase: 'outgoing', callId: CALL_ID });
    expect(ends()).toEqual([]);
    event({ type: 'accepted' }); // and the call carries on normally
    await flush();
    expect(store().phase).toBe('connecting');
  });

  it('caller: a read sent while POST /calls was in flight does not end the call it created', async () => {
    const created = defer();
    server.start = created.promise;
    const dialling = engine.startCall(PEER);
    await flush();
    expect(requests('POST /calls')).toHaveLength(1); // waiting for the server's call id

    const read = holdNextCallRead();
    const reconciling = engine.reconcileCall();
    await read.arrived; // the server had not created the call yet
    created.resolve(server.startResponse());
    await dialling;
    expect(store()).toMatchObject({ phase: 'outgoing', callId: CALL_ID });

    read.release();
    await reconciling;
    await flush();
    expect(store()).toMatchObject({ phase: 'outgoing', callId: CALL_ID });
    expect(ends()).toEqual([]);
  });

  it('a call that ended meanwhile gets no "end" request, and a newer call keeps ringing', async () => {
    invite(); // CALL_ID rings
    const read = holdNextCallRead();
    const reconciling = engine.reconcileCall();
    await read.arrived; // the server still had CALL_ID ringing
    event({ type: 'ended', status: 'cancelled' }); // then the caller gave up
    engine.handleCallEvent({
      type: 'invite',
      callId: NEWER,
      callerUserId: PEER,
      createdAt: CREATED,
      ringExpiresAt: EXPIRES,
    }); // and called again

    read.release();
    await reconciling;
    await flush();
    expect(store()).toMatchObject({ phase: 'incoming', callId: NEWER });
    expect(ends()).toEqual([]); // CALL_ID is over on the server: nothing to end
    const [old] = await require('../src/calls/callHistory').listCallLog();
    expect(old).toMatchObject({ callId: CALL_ID, outcome: 'missed' });
  });

  it('a read in flight at sign-out never rings or ends anything afterwards', async () => {
    server.current = callView('callee'); // a call ringing for the account (its invite was lost)
    const read = holdNextCallRead();
    const reconciling = engine.reconcileCall();
    await read.arrived;
    engine.endCallForSignOut();

    read.release();
    await reconciling;
    await flush();
    expect(store().phase).toBe('idle');
    expect(media.audio.startRingtone).not.toHaveBeenCalled();
    expect(ends()).toEqual([]);
  });
});

describe('sign-out and account deletion during a call', () => {
  it('logout ends the call and releases microphone and connection', async () => {
    await connectedOutgoingCall();
    const connection = pc();
    await app.auth.useAuthStore.getState().logout();
    expect(store().phase).toBe('idle');
    expect(connection.closed).toBe(true);
    expect(media.__state.streams[0].track.stopped).toBe(true);
  });

  it('account deletion ends the call too', async () => {
    await connectedOutgoingCall();
    const connection = pc();
    await app.auth.useAuthStore.getState().deleteAccount();
    expect(store().phase).toBe('idle');
    expect(connection.closed).toBe(true);
  });
});

describe('in-call controls', () => {
  it('mute disables the microphone track; speaker switches the audio route', async () => {
    await connectedOutgoingCall();
    const { track } = media.__state.streams[0];
    engine.toggleMute();
    expect([store().muted, track.enabled]).toEqual([true, false]);
    engine.toggleMute();
    expect([store().muted, track.enabled]).toEqual([false, true]);
    engine.toggleSpeaker();
    expect(store().speaker).toBe(true);
    expect(media.audio.setSpeaker).toHaveBeenLastCalledWith(true);
  });
});

describe('call screen and Chat Lock', () => {
  let React;
  let act;
  let create;
  beforeEach(() => {
    React = require('react');
    ({ act, create } = require('react-test-renderer'));
  });

  async function renderCallScreen() {
    const Screen = require('../src/app/(app)/call').default;
    let tree;
    await act(async () => {
      tree = create(React.createElement(Screen));
    });
    await act(async () => flush());
    return tree;
  }

  it('does not reveal who calls from a locked chat until Chat Lock authentication', async () => {
    const messages = require('../src/messaging/messageStore');
    await messages.ensureConversation(PEER, { title: 'Bob Secret', at: Date.now() });
    await messages.setConversationLocked(PEER, true);
    invite();

    const tree = await renderCallScreen();
    const text = () => JSON.stringify(tree.toJSON());
    expect(text()).toMatch(/CipherChat call/);
    expect(text()).toMatch(/Incoming voice call/);
    expect(text()).not.toMatch(/Bob|"BS"/);
    expect(text()).toMatch(/Unlock to see caller/);

    globalThis.__device.auth = { level: 3, types: [1], results: [{ success: true }], prompts: [] };
    await act(async () => {
      await require('../src/security/chatLock').unlockChats();
    });
    expect(text()).toMatch(/Bob Secret/);
    await act(async () => tree.unmount());
  });

  it('shows the contact name for unlocked chats, and never claims Signal-style E2EE for calls', async () => {
    const messages = require('../src/messaging/messageStore');
    await messages.ensureConversation(PEER, { title: 'Bob', at: Date.now() });
    invite();
    const tree = await renderCallScreen();
    const text = JSON.stringify(tree.toJSON());
    expect(text).toMatch(/Bob/);
    expect(text).toMatch(/Encrypted voice call/);
    expect(text).not.toMatch(/end-to-end/i);
    await act(async () => tree.unmount());
  });

  it('tells the callee they missed a call the caller cancelled', async () => {
    invite();
    const tree = await renderCallScreen();
    await act(async () => event({ type: 'ended', status: 'cancelled' }));
    const text = JSON.stringify(tree.toJSON());
    expect(text).toMatch(/Missed call/);
    expect(text).not.toMatch(/No answer/);
    await act(async () => tree.unmount());
  });
});

describe('background microphone service', () => {
  const load = (native) => {
    let wrapper;
    jest.isolateModules(() => {
      jest.doMock('expo', () => ({ requireOptionalNativeModule: () => native }));
      wrapper = jest.requireActual('../modules/call-service');
    });
    return wrapper;
  };

  it('is a harmless no-op where the native module does not exist (iOS)', () => {
    const { startCallService, stopCallService } = load(null);
    expect(startCallService()).toBe(false);
    expect(() => stopCallService()).not.toThrow();
  });

  it('reports a refused start as false and never throws into the call', () => {
    const native = {
      start: jest.fn(() => {
        throw new Error('not allowed from the background');
      }),
      stop: jest.fn(() => {
        throw new Error('not running');
      }),
    };
    const { startCallService, stopCallService } = load(native);
    expect(startCallService()).toBe(false);
    expect(() => stopCallService()).not.toThrow();
    native.start.mockImplementation(() => true);
    expect(startCallService()).toBe(true);
  });
});

describe('call history (kept only on this phone)', () => {
  const history = () => require('../src/calls/callHistory');
  const log = async () => {
    await flush();
    return history().listCallLog();
  };
  let count = 0;
  const nextId = () => `22222222-2222-4222-8222-${String((count += 1)).padStart(12, '0')}`;
  const remoteEnd = (status) => (callId) =>
    engine.handleCallEvent({ type: 'ended', callId, status });

  /** An outgoing call with its own id, ended by `end`. */
  async function outgoing(callId, end) {
    server.start = {
      status: 201,
      body: { call: { ...callView('caller'), callId }, iceServers: ICE },
    };
    await engine.startCall(PEER);
    await end(callId);
    await flush();
  }

  /** An incoming call with its own id, ended by `end`. */
  async function incoming(callId, end) {
    engine.handleCallEvent({
      type: 'invite',
      callId,
      callerUserId: PEER,
      createdAt: CREATED,
      ringExpiresAt: EXPIRES,
    });
    await end(callId);
    await flush();
  }

  async function render(path, props) {
    const React = require('react');
    const { act, create } = require('react-test-renderer');
    const Screen = require(path).default;
    let tree;
    await act(async () => {
      tree = create(React.createElement(Screen, props));
    });
    await act(async () => flush());
    // Every visible string, one <Text> per line (lists cannot be JSON-serialized).
    const { Text } = require('react-native');
    const text = () =>
      tree.root
        .findAllByType(Text)
        .map((node) =>
          []
            .concat(node.props.children)
            .filter((c) => typeof c === 'string' || typeof c === 'number')
            .join(''),
        )
        .join('\n');
    return { tree, act, text };
  }

  it('records an answered call with how long it lasted', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    jest.setSystemTime(Date.now() + 125_000);
    engine.hangUp();

    const [entry] = await log();
    expect(entry).toMatchObject({
      callId: CALL_ID,
      peerUserId: PEER,
      direction: 'out',
      outcome: 'answered',
    });
    expect(entry.endedAt - entry.connectedAt).toBe(125_000);
    expect(history().describeCall(entry)).toEqual({
      outgoing: true,
      missed: false,
      video: false,
      title: 'Voice call',
      kind: 'Outgoing',
      detail: '2:05',
    });
  });

  it('records how each call ended, from this phone’s side', async () => {
    await outgoing(nextId(), remoteEnd('rejected'));
    await outgoing(nextId(), remoteEnd('missed'));
    await outgoing(nextId(), () => engine.hangUp());
    server.start = { status: 409, body: { error: { code: 'CALLEE_BUSY' } } };
    await engine.startCall(PEER);
    // No microphone: nothing was dialled, so nothing is recorded.
    media.__state.micError = Object.assign(new Error('denied'), { code: 'MIC_PERMISSION_DENIED' });
    await engine.startCall(PEER);
    media.__state.micError = null;
    await incoming(nextId(), remoteEnd('cancelled'));
    await incoming(nextId(), () => engine.declineCall());

    const rows = await log();
    expect(rows.map((r) => `${r.direction} ${r.outcome}`).sort()).toEqual(
      [
        'out declined',
        'out no_answer',
        'out cancelled',
        'out busy',
        'in missed',
        'in declined',
      ].sort(),
    );
    // Refused before the server created a call: a local id.
    expect(rows.find((r) => r.outcome === 'busy').callId).toMatch(/^local-/);
    const describe = (outcome) => history().describeCall(rows.find((r) => r.outcome === outcome));
    expect(describe('missed')).toMatchObject({
      missed: true,
      title: 'Missed voice call',
      kind: 'Missed',
    });
    expect(describe('no_answer')).toMatchObject({ missed: false, detail: 'No answer' });
    expect(describe('busy').detail).toBe('Busy');
  });

  it('records nothing when the call ends because this phone signs out', async () => {
    await connectedOutgoingCall();
    engine.endCallForSignOut();
    expect(await log()).toEqual([]);
  });

  it('collects calls missed while the app was closed, once, then lets the server forget them', async () => {
    const seen = nextId();
    await incoming(seen, remoteEnd('cancelled')); // this phone saw this one ring
    const [local] = await log();
    const unseen = nextId();
    server.missed = [
      { callId: unseen, callerUserId: PEER, createdAt: CREATED, endedAt: EXPIRES },
      { callId: seen, callerUserId: PEER, createdAt: CREATED, endedAt: EXPIRES },
      { callId: 42 }, // malformed: skipped, never acknowledged
    ];

    expect(await history().syncMissedCalls()).toBe(2);
    expect(requests('POST /calls/missed/ack').map((c) => c.body)).toEqual([
      { callIds: [unseen, seen] },
    ]);
    const rows = await log();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.callId === unseen)).toMatchObject({
      peerUserId: PEER,
      direction: 'in',
      outcome: 'missed',
      startedAt: Date.parse(CREATED),
      endedAt: Date.parse(EXPIRES),
      connectedAt: null,
    });
    // This phone's own record of a call is kept as it was.
    expect(rows.find((r) => r.callId === seen)).toEqual(local);

    // Collected again (e.g. the acknowledgement was lost): nothing is added twice.
    await history().syncMissedCalls();
    expect(await log()).toHaveLength(2);
  });

  it('Calls tab: newest first, missed calls stand out, a locked chat’s calls stay anonymous until unlocked', async () => {
    const messages = require('../src/messaging/messageStore');
    const CAROL = 'cccccccccccccccccccccccc';
    await messages.ensureConversation(PEER, { title: 'Bob', at: Date.now() });
    await messages.ensureConversation(CAROL, { title: 'Carol Secret', at: Date.now() });
    await messages.setConversationLocked(CAROL, true);
    const missedId = nextId();
    const lockedId = nextId();
    await history().recordCall({
      callId: missedId,
      peerUserId: PEER,
      direction: 'incoming',
      outcome: 'missed',
      startedAt: 1_000,
      endedAt: 2_000,
    });
    await history().recordCall({
      callId: lockedId,
      peerUserId: CAROL,
      direction: 'outgoing',
      outcome: 'answered',
      startedAt: 3_000,
      connectedAt: 4_000,
      endedAt: 64_000,
    });

    const { tree, act, text } = await render('../src/app/(app)/(tabs)/calls');
    const label = (callId) =>
      tree.root.findByProps({ testID: `call-log-${callId}` }).props.accessibilityLabel;
    expect(text()).toMatch(/Bob/);
    expect(label(missedId)).toMatch(/^Bob, Missed call, /);
    expect(text()).toMatch(/Locked chat/);
    expect(text()).not.toMatch(/Carol/);
    expect(label(lockedId)).not.toMatch(/Carol/);
    expect(text().indexOf('Locked chat')).toBeLessThan(text().indexOf('Bob')); // newest first

    globalThis.__device.auth = { level: 3, types: [1], results: [{ success: true }], prompts: [] };
    await act(async () => {
      await require('../src/security/chatLock').unlockChats();
    });
    expect(text()).toMatch(/Carol Secret/);
    expect(label(lockedId)).toMatch(/^Carol Secret, Outgoing call, .* · 1:00$/);
    await act(async () => tree.unmount());
  });

  it('a chat shows its calls in the timeline; tapping one calls back', async () => {
    const messages = require('../src/messaging/messageStore');
    await messages.ensureConversation(PEER, { title: 'Bob', at: Date.now() });
    const now = Date.now();
    const missedId = nextId();
    await history().recordCall({
      callId: missedId,
      peerUserId: PEER,
      direction: 'incoming',
      outcome: 'missed',
      startedAt: now - 60_000,
      endedAt: now - 50_000,
    });
    await history().recordCall({
      callId: nextId(),
      peerUserId: PEER,
      direction: 'outgoing',
      outcome: 'answered',
      startedAt: now - 40_000,
      connectedAt: now - 35_000,
      endedAt: now - 5_000,
    });

    globalThis.__routeParams = { peerUserId: PEER };
    try {
      const { tree, act, text } = await render('../src/app/(app)/chat/[peerUserId]');
      expect(text()).toMatch(/Missed voice call/);
      expect(text()).toMatch(/Tap to call back/);
      expect(text()).toMatch(/^Voice call$/m);
      expect(text()).toMatch(/0:30/);

      await act(async () => {
        tree.root.findByProps({ testID: `call-entry-${missedId}` }).props.onPress();
      });
      await act(async () => flush());
      expect(requests('POST /calls')[0].body).toEqual({ calleeUserId: PEER, kind: 'voice' });
      await act(async () => tree.unmount());
    } finally {
      globalThis.__routeParams = undefined;
    }
  });
});

describe('ICE: relay policy, connection path, candidates and cleanup', () => {
  const TURN_SERVER = {
    urls: ['turn:turn.example.com:3478?transport=udp'],
    username: '1760000000:11111111-1111-4111-8111-111111111111',
    credential: 'dHVybi1jcmVkZW50aWFsLWZvci10aGlzLWNhbGw=',
  };
  const candidate = (n) => ({
    candidate: `candidate:${n} 1 udp 2122260223 192.0.2.${n % 250} 5${String(n).padStart(4, '0')} typ host`,
    sdpMid: '0',
    sdpMLineIndex: 0,
  });
  const remoteCandidates = (list) =>
    event({ type: 'signal', kind: 'candidates', candidates: list });

  /** Outgoing call that has received the answer (remote description set), not yet connected. */
  async function answeredOutgoingCall() {
    await engine.startCall(PEER);
    event({ type: 'accepted' });
    await flush();
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' });
    await flush();
  }

  it('caller: the peer connection gets the API’s ICE servers and its relay-only policy', async () => {
    server.start = {
      status: 201,
      body: { call: callView('caller'), iceServers: [TURN_SERVER], iceTransportPolicy: 'relay' },
    };
    await engine.startCall(PEER);
    event({ type: 'accepted' });
    await flush();
    expect(pc().iceServers).toEqual([TURN_SERVER]);
    expect(pc().options).toEqual({ iceTransportPolicy: 'relay' });
  });

  it('callee: the relay-only policy comes with the accept response', async () => {
    server.accept = {
      body: {
        call: callView('callee', 'accepted'),
        iceServers: [TURN_SERVER],
        iceTransportPolicy: 'relay',
      },
    };
    invite();
    await engine.answerCall();
    await flush();
    expect(pc().iceServers).toEqual([TURN_SERVER]);
    expect(pc().options).toEqual({ iceTransportPolicy: 'relay' });
  });

  it('without a policy from the API nothing is forced (media maps it to "all")', async () => {
    await engine.startCall(PEER);
    event({ type: 'accepted' });
    await flush();
    expect(pc().options).toEqual({ iceTransportPolicy: null });
  });

  it('reports which path the call uses, again after a reconnect, never after it ended', async () => {
    media.__state.route = 'host';
    await connectedOutgoingCall();
    await flush();
    expect(store().route).toBe('host');

    // Network switch: the connection drops and comes back over another path.
    media.__state.route = 'relay';
    pc().setConnectionState('disconnected');
    expect(store().phase).toBe('reconnecting');
    pc().setConnectionState('connected');
    await flush();
    expect(store()).toMatchObject({ phase: 'connected', route: 'relay' });
    engine.hangUp();
    await flush();

    // Stats that arrive after the call ended change nothing.
    const late = defer();
    media.getConnectionRoute.mockImplementationOnce(() => late.promise);
    const nextCall = '44444444-4444-4444-8444-444444444444';
    server.start = {
      status: 201,
      body: { call: { ...callView('caller'), callId: nextCall }, iceServers: ICE },
    };
    await engine.startCall(PEER);
    engine.handleCallEvent({ type: 'accepted', callId: nextCall });
    await flush();
    engine.handleCallEvent({ type: 'signal', callId: nextCall, kind: 'answer', sdp: 'v=0 answer' });
    await flush();
    pc().setConnectionState('connected');
    expect(store().route).toBeNull();
    engine.hangUp();
    late.resolve({ route: 'reflexive' });
    await flush();
    expect(store().route).toBeNull();
  });

  it('applies each remote candidate once: duplicates in a batch, across batches, before the answer', async () => {
    await engine.startCall(PEER);
    event({ type: 'accepted' });
    await flush();
    // Before the answer: queued, duplicates dropped.
    remoteCandidates([candidate(1), candidate(1), candidate(2)]);
    remoteCandidates([candidate(2)]);
    await flush();
    expect(pc().addedCandidates).toEqual([]);
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' });
    await flush();
    remoteCandidates([candidate(1), candidate(3)]); // a resend after the answer
    await flush();
    expect(pc().addedCandidates.map((c) => c.candidate)).toEqual([
      candidate(1).candidate,
      candidate(2).candidate,
      candidate(3).candidate,
    ]);
  });

  it('ignores oversized candidates and caps a flood of remote candidates per call', async () => {
    const { CALL_LIMITS } = require('@secure-chat/shared/constants');
    await answeredOutgoingCall();
    remoteCandidates([
      { candidate: `candidate:x ${'a'.repeat(600)}`, sdpMid: '0', sdpMLineIndex: 0 },
    ]);
    for (let batch = 0; batch < 8; batch += 1) {
      remoteCandidates(Array.from({ length: 20 }, (_, i) => candidate(batch * 20 + i + 10)));
    }
    await flush();
    // One exchange (no restart): still capped at the same 100 as before.
    expect(CALL_LIMITS.CANDIDATES_PER_GENERATION).toBe(100);
    expect(pc().addedCandidates).toHaveLength(CALL_LIMITS.CANDIDATES_PER_GENERATION);
    expect(pc().addedCandidates.some((c) => c.candidate.length > 512)).toBe(false);
    expect(store().phase).toBe('connecting'); // the call itself carries on
  });

  it('each ICE restart gets its own candidate budget; the whole call stays bounded', async () => {
    const { CALL_LIMITS } = require('@secure-chat/shared/constants');
    await connectedOutgoingCall();
    let next = 1000;
    const batchOf = (n) => Array.from({ length: n }, () => candidate((next += 1)));
    // Many network switches: each restart brings a fresh set (40 here, more than a real one).
    for (let restart = 1; restart <= 4; restart += 1) {
      engine.handleCallNetworkChange();
      await flush();
      event({ type: 'signal', kind: 'answer', sdp: `v=0 answer ${restart}`, restart });
      await flush();
      remoteCandidates(batchOf(20));
      remoteCandidates(batchOf(20));
      await flush();
      pc().setConnectionState('connected');
    }
    // 160 > the old per-call cap of 100: later restarts can still connect.
    expect(pc().addedCandidates).toHaveLength(160);

    // And a hostile peer forcing restarts still cannot exceed the per-call total.
    for (let restart = 5; restart <= 12; restart += 1) {
      engine.handleCallNetworkChange();
      await flush();
      event({ type: 'signal', kind: 'answer', sdp: `v=0 answer ${restart}`, restart });
      await flush();
      for (let b = 0; b < 6; b += 1) remoteCandidates(batchOf(20));
      await flush();
      pc().setConnectionState('connected');
    }
    expect(pc().addedCandidates).toHaveLength(CALL_LIMITS.CANDIDATES_PER_CALL);
  });

  it('late candidates after the call ended are ignored, local and remote, and nothing is sent', async () => {
    await answeredOutgoingCall();
    const connection = pc();
    // A local candidate starts a batch; hanging up within the batch window cancels it.
    connection.emit('icecandidate', { candidate: candidate(1) });
    engine.hangUp();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flush();
    expect(signals().filter((s) => s.kind === 'candidates')).toEqual([]);

    // After cleanup: no listeners left, and remote candidates for the old call do nothing.
    expect(connection.listenerCount()).toBe(0);
    connection.emit('icecandidate', { candidate: candidate(2) });
    expect(() => remoteCandidates([candidate(3)])).not.toThrow();
    await flush();
    expect(connection.addedCandidates).toEqual([]);
    expect(signals().filter((s) => s.kind === 'candidates')).toEqual([]);
  });

  it('candidates for another call are ignored; a callee keeps early ones until it answers', async () => {
    invite();
    remoteCandidates([candidate(1)]); // before answering: no peer connection yet
    engine.handleCallEvent({
      type: 'signal',
      callId: '99999999-9999-4999-8999-999999999999',
      kind: 'candidates',
      candidates: [candidate(9)],
    });
    await engine.answerCall();
    await flush();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush();
    expect(pc().addedCandidates.map((c) => c.candidate)).toEqual([candidate(1).candidate]);
  });

  it('cleanup closes everything once; nothing fires afterwards', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    const connection = pc();
    connection.setConnectionState('disconnected'); // arms reconnect + ICE-restart timers
    engine.hangUp();
    engine.hangUp();
    await flush(); // the hang-up's own POST /end goes out
    const requestsBefore = server.calls.length;
    await jest.advanceTimersByTimeAsync(60_000); // past every call timer
    expect(server.calls.length).toBe(requestsBefore); // no restart offer, no second /end
    expect(connection.closed).toBe(true);
    expect(connection.restarted).toBeUndefined();
    expect(connection.listenerCount()).toBe(0);
    expect(media.__state.streams[0].track.stopped).toBe(true);
    expect(media.keepAlive.stop).toHaveBeenCalled();
    expect(ends()).toEqual([{ reason: 'hangup' }]);
  });

  it('keeps TURN credentials inside the peer connection: not in UI state, call history or logs', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
      jest.spyOn(console, name).mockImplementation(() => {}),
    );
    try {
      server.start = {
        status: 201,
        body: { call: callView('caller'), iceServers: [TURN_SERVER] },
      };
      await engine.startCall(PEER);
      event({ type: 'accepted' });
      await flush();
      event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' });
      await flush();
      pc().setConnectionState('connected');
      const uiState = JSON.stringify(store());
      engine.hangUp();
      await flush();
      const history = JSON.stringify(await require('../src/calls/callHistory').listCallLog());
      const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
      for (const text of [uiState, history, logged]) {
        expect(text).not.toContain(TURN_SERVER.credential);
        expect(text).not.toContain(TURN_SERVER.username);
        expect(text).not.toContain('turn.example.com');
      }
      // Only the requests to our own API carry signaling; none of them echoes the credential.
      expect(JSON.stringify(server.calls.map((c) => c.body))).not.toContain(TURN_SERVER.credential);
    } finally {
      logs.forEach((spy) => spy.mockRestore());
    }
  });
});

describe('connection path label follows the selected pair', () => {
  it('says unknown when the stats name no pair, then tracks pair changes while connected', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    media.__state.route = null; // stats without a selected pair
    await connectedOutgoingCall();
    await flush();
    expect(store().route).toBe('undetermined'); // honest, not a guess
    // An ICE restart moved the call to another pair without any state change.
    media.__state.route = 'host';
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ROUTE_REFRESH_MS);
    expect(store().route).toBe('host');
    media.__state.route = 'relay';
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ROUTE_REFRESH_MS);
    expect(store().route).toBe('relay');
    // Not re-read while reconnecting, nor after the call ended.
    pc().setConnectionState('disconnected');
    const reads = media.getConnectionRoute.mock.calls.length;
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ROUTE_REFRESH_MS * 2);
    expect(media.getConnectionRoute.mock.calls.length).toBe(reads);
    engine.hangUp();
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ROUTE_REFRESH_MS * 3);
    expect(media.getConnectionRoute.mock.calls.length).toBe(reads);
  });
});

describe('call screen: connection path (development builds only)', () => {
  it('shows which path a connected call uses, as a label without any address', async () => {
    const React = require('react');
    const { act, create } = require('react-test-renderer');
    media.__state.route = 'relay';
    await connectedOutgoingCall();
    await flush();

    const Screen = require('../src/app/(app)/call').default;
    let tree;
    await act(async () => {
      tree = create(React.createElement(Screen));
    });
    await act(async () => flush());
    expect(tree.root.findByProps({ testID: 'call-route' }).props.children).toBe('Relayed · TURN');
    await act(async () => tree.unmount());
  });
});

describe('video calls', () => {
  const VIDEO_CALL = '55555555-5555-4555-8555-555555555555';
  const videoView = (role, status = 'ringing') => ({ ...callView(role, status), kind: 'video' });
  const videoInvite = (callId = CALL_ID) =>
    engine.handleCallEvent({
      type: 'invite',
      callId,
      callerUserId: PEER,
      kind: 'video',
      createdAt: CREATED,
      ringExpiresAt: EXPIRES,
    });
  /** Our live (not stopped) camera track, if any. */
  const localVideo = () =>
    media.__state.streams
      .flatMap((s) => s.getVideoTracks())
      .filter((t) => !t.stopped)
      .at(-1) ?? null;
  const mediaSignals = () => signals().filter((s) => s.kind === 'media');
  /** The other phone's camera track arrives (react-native-webrtc fires `track` per track). */
  const remoteVideoArrives = (url = 'remote-stream-1') =>
    pc().emit('track', {
      track: { kind: 'video' },
      streams: [{ toURL: () => url, getTracks: () => [] }],
    });

  async function startVideoCall() {
    server.start = { status: 201, body: { call: videoView('caller'), iceServers: ICE } };
    await engine.startCall(PEER, { video: true });
  }

  /** Outgoing video call up to "connected", with the other phone's video arriving. */
  async function connectedVideoCall() {
    await startVideoCall();
    event({ type: 'accepted' });
    await flush();
    remoteVideoArrives();
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' });
    await flush();
    pc().setConnectionState('connected');
    await flush();
  }

  it('an outgoing video call captures camera + microphone, sends kind=video, and shows both videos', async () => {
    await startVideoCall();
    expect(media.getMedia).toHaveBeenCalledWith({ video: true, facing: 'user' });
    expect(requests('POST /calls')[0].body).toEqual({ calleeUserId: PEER, kind: 'video' });
    expect(store()).toMatchObject({
      phase: 'outgoing',
      kind: 'video',
      speaker: true, // video is watched at arm's length
      cameraOff: false,
      facing: 'user',
      localStreamUrl: 'stream-1',
      remoteStreamUrl: null,
      remoteVideo: false,
    });

    event({ type: 'accepted' });
    await flush();
    expect(pc().tracks.map((t) => t.kind)).toEqual(['audio', 'video']); // both sent
    expect(media.audio.start).toHaveBeenCalledWith('video');
    remoteVideoArrives('their-stream');
    expect(store()).toMatchObject({ remoteStreamUrl: 'their-stream', remoteVideo: true });
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' });
    await flush();
    pc().setConnectionState('connected');
    expect(store().phase).toBe('connected');
    expect(mediaSignals()).toEqual([]); // camera on: nothing to announce
  });

  it('an incoming video call rings as one; answering captures the camera too', async () => {
    videoInvite();
    expect(store()).toMatchObject({ phase: 'incoming', kind: 'video', direction: 'incoming' });
    expect(media.getMedia).not.toHaveBeenCalled(); // nothing captured before answering
    server.accept = { body: { call: videoView('callee', 'accepted'), iceServers: ICE } };
    await engine.answerCall();
    await flush();
    expect(media.getMedia).toHaveBeenCalledWith({ video: true, facing: 'user' });
    expect(store()).toMatchObject({
      phase: 'connecting',
      kind: 'video',
      localStreamUrl: 'stream-1',
    });
    expect(pc().tracks.map((t) => t.kind)).toEqual(['audio', 'video']);
  });

  it('a voice invite stays a voice call; an unknown kind is treated as voice', async () => {
    engine.handleCallEvent({
      type: 'invite',
      callId: CALL_ID,
      callerUserId: PEER,
      kind: 'hologram',
      createdAt: CREATED,
      ringExpiresAt: EXPIRES,
    });
    expect(store()).toMatchObject({ phase: 'incoming', kind: 'voice', speaker: false });
    await engine.answerCall();
    expect(media.getMedia).toHaveBeenCalledWith({ video: false, facing: 'user' });
  });

  it('caller: camera refused ends the attempt before anything reaches the server', async () => {
    media.__state.cameraError = Object.assign(new Error('denied'), {
      code: 'CAMERA_PERMISSION_DENIED',
    });
    await engine.startCall(PEER, { video: true });
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'camera_denied' });
    expect(requests('POST /calls')).toHaveLength(0);
    expect(media.keepAlive.start).not.toHaveBeenCalled();
    await flush();
    expect(await require('../src/calls/callHistory').listCallLog()).toEqual([]); // never a call
    media.__state.cameraError = null;
  });

  it('callee: camera refused still answers, audio only, and tells the caller the camera is off', async () => {
    media.__state.cameraError = Object.assign(new Error('denied'), {
      code: 'CAMERA_PERMISSION_DENIED',
    });
    videoInvite();
    server.accept = { body: { call: videoView('callee', 'accepted'), iceServers: ICE } };
    await engine.answerCall();
    await flush();
    expect(store()).toMatchObject({
      phase: 'connecting',
      kind: 'video',
      cameraUnavailable: true,
      localStreamUrl: null,
    });
    expect(pc().tracks.map((t) => t.kind)).toEqual(['audio']);
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush();
    pc().setConnectionState('connected');
    await flush();
    expect(mediaSignals()).toEqual([{ kind: 'media', video: false }]);
    engine.toggleCamera(); // nothing to switch on
    expect(store().cameraOff).toBe(false);
    media.__state.cameraError = null;
  });

  it('microphone refused ends a video call like a voice call', async () => {
    media.__state.micError = Object.assign(new Error('denied'), { code: 'MIC_PERMISSION_DENIED' });
    await engine.startCall(PEER, { video: true });
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'permission_denied' });
    media.__state.micError = null;
  });

  it('camera off/on stops and resumes sending frames and tells the other phone', async () => {
    await connectedVideoCall();
    const track = localVideo();
    engine.toggleCamera();
    expect([store().cameraOff, track.enabled]).toEqual([true, false]);
    engine.toggleCamera();
    expect([store().cameraOff, track.enabled]).toEqual([false, true]);
    await flush();
    expect(mediaSignals()).toEqual([
      { kind: 'media', video: false },
      { kind: 'media', video: true },
    ]);
    // Mute is independent of the camera.
    engine.toggleMute();
    expect([store().muted, media.__state.streams.at(-1).track.enabled]).toEqual([true, false]);
    expect(track.enabled).toBe(true);
  });

  it('switches between front and back camera without renegotiation; a single camera is harmless', async () => {
    await connectedVideoCall();
    const offersBefore = pc().offers;
    engine.switchCamera();
    expect(store().facing).toBe('environment');
    engine.switchCamera();
    expect(store().facing).toBe('user');
    expect(localVideo().switches).toBe(2);
    expect(pc().offers).toBe(offersBefore);

    media.__state.singleCamera = true;
    engine.switchCamera();
    expect(store().facing).toBe('user'); // unchanged, no error
    media.__state.singleCamera = false;
  });

  it('shows whether the other phone sends video, from their media signals, in any order', async () => {
    await startVideoCall();
    event({ type: 'accepted' });
    await flush();
    // Their "camera off" can arrive before their track does.
    event({ type: 'signal', kind: 'media', video: false });
    await flush();
    remoteVideoArrives();
    expect(store()).toMatchObject({ remoteStreamUrl: 'remote-stream-1', remoteVideo: false });
    event({ type: 'signal', kind: 'media', video: true });
    await flush();
    expect(store().remoteVideo).toBe(true);
    event({ type: 'signal', kind: 'media', video: 'yes' }); // malformed: ignored
    await flush();
    expect(store().remoteVideo).toBe(true);
    // A media signal for some other call is ignored (same guard as all signaling).
    engine.handleCallEvent({ type: 'signal', callId: VIDEO_CALL, kind: 'media', video: false });
    await flush();
    expect(store().remoteVideo).toBe(true);
  });

  it('leaving the app releases our camera and tells the other phone; returning reopens it', async () => {
    await connectedVideoCall();
    const first = localVideo();
    const sender = pc().senders.find((x) => x.track === first);
    engine.handleCallAppState('background');
    await flush();
    expect(first.stopped).toBe(true); // camera released, not just paused
    expect(sender.replaced).toEqual([null]); // nothing sent in its place
    expect(store().localStreamUrl).toBeNull();
    engine.handleCallAppState('background'); // again: nothing more happens
    await flush();
    expect(media.getMedia).toHaveBeenCalledTimes(1); // still only the original capture

    engine.handleCallAppState('active');
    await flush();
    // Reopened camera only (the microphone was never released), swapped into the same sender.
    expect(media.getMedia).toHaveBeenLastCalledWith({ audio: false, video: true, facing: 'user' });
    const second = localVideo();
    expect(second).not.toBe(first);
    expect([second.enabled, second.stopped]).toEqual([true, false]);
    expect(sender.replaced).toEqual([null, second]);
    expect(store().localStreamUrl).toBe(media.__state.streams.at(-1).toURL());
    expect(mediaSignals()).toEqual([
      { kind: 'media', video: false },
      { kind: 'media', video: true },
    ]);
    expect(store().phase).toBe('connected'); // audio carried on throughout
    expect(media.__state.streams[0].track.stopped).toBe(false); // microphone untouched

    // Camera switched off by the user stays released across a background/foreground cycle,
    // and comes back only when they switch it on again.
    engine.toggleCamera();
    engine.handleCallAppState('background');
    await flush();
    engine.handleCallAppState('active');
    await flush();
    expect([store().cameraOff, localVideo()]).toEqual([true, null]);
    expect(media.getMedia).toHaveBeenCalledTimes(2);
    engine.toggleCamera();
    await flush();
    expect(media.getMedia).toHaveBeenCalledTimes(3);
    expect([store().cameraOff, localVideo()?.enabled]).toEqual([false, true]);
    expect(sender.replaced).toHaveLength(4); // null, second, null, third
  });

  it('a camera that cannot be reopened after the background leaves the call on audio', async () => {
    await connectedVideoCall();
    engine.handleCallAppState('background');
    await flush();
    media.__state.cameraError = Object.assign(new Error('revoked'), {
      code: 'CAMERA_PERMISSION_DENIED',
    });
    engine.handleCallAppState('active');
    await flush();
    expect(store().phase).toBe('connected');
    expect(localVideo()).toBeNull();
    media.__state.cameraError = null;
  });

  /** The next getMedia waits for `gate` (a slow permission dialog or camera start). */
  const holdNextCapture = () => {
    const gate = defer();
    const capture = media.getMedia.getMockImplementation();
    media.getMedia.mockImplementationOnce(async (options) => {
      await gate.promise;
      return capture(options);
    });
    return gate;
  };

  it('the permission dialog pausing the app while answering does not open the camera twice', async () => {
    videoInvite();
    server.accept = { body: { call: videoView('callee', 'accepted'), iceServers: ICE } };
    const dialog = holdNextCapture();
    const answering = engine.answerCall();
    await flush();
    // A first call's camera dialog pauses the app; it resumes when the dialog closes. Seen on
    // Android 16: reopening the camera then raced the answer's own capture and wedged WebRTC.
    engine.handleCallAppState('background');
    engine.handleCallAppState('active');
    await flush();
    dialog.resolve();
    await answering;
    await flush();
    expect(media.getMedia).toHaveBeenCalledTimes(1);
    expect(media.__state.streams.flatMap((s) => s.getVideoTracks())).toHaveLength(1);
    expect(store()).toMatchObject({ phase: 'connecting', localStreamUrl: 'stream-1' });
    expect(pc().tracks.map((t) => t.kind)).toEqual(['audio', 'video']);
  });

  it('releasing and reopening the camera never overlap', async () => {
    await connectedVideoCall();
    engine.handleCallAppState('background');
    await flush();
    const opening = holdNextCapture();
    engine.handleCallAppState('active');
    await flush();
    engine.handleCallAppState('background'); // left again while the camera is still opening
    await flush();
    expect(localVideo()).toBeNull();
    opening.resolve();
    await flush();
    // The release waited for the reopen to finish, then closed what it opened.
    expect(media.getMedia).toHaveBeenCalledTimes(2);
    expect(localVideo()).toBeNull();
    expect(store()).toMatchObject({ phase: 'connected', localStreamUrl: null });
  });

  it('a camera or microphone that never starts ends the call with a reason, not "Calling…" forever', async () => {
    const stuck = Object.assign(new Error('did not start'), { code: 'MEDIA_TIMEOUT' });
    media.getMedia.mockRejectedValueOnce(stuck);
    await engine.startCall(PEER, { video: true });
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'media_unavailable' });
    expect(requests('POST /calls')).toHaveLength(0);
    await flush();
    expect(await require('../src/calls/callHistory').listCallLog()).toEqual([]); // never a call

    engine.dismissEndedCall();
    videoInvite(VIDEO_CALL);
    media.getMedia.mockRejectedValueOnce(stuck);
    await engine.answerCall();
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'media_unavailable' });
    expect(requests(`POST /calls/${VIDEO_CALL}/end`).map((c) => c.body)).toEqual([
      { reason: 'failed' },
    ]);
  });

  it('voice calls ignore app-state changes (no camera to pause)', async () => {
    await connectedOutgoingCall();
    const before = signals().length;
    engine.handleCallAppState('background');
    engine.handleCallAppState('active');
    await flush();
    expect(signals().length).toBe(before);
  });

  it('hang-up, rejection, timeout and logout release camera, microphone and video views', async () => {
    const released = () => {
      const stream = media.__state.streams.at(-1);
      return {
        audio: stream.track.stopped,
        video: stream.videoTrack?.stopped ?? null,
        local: store().localStreamUrl,
        remote: store().remoteStreamUrl,
        remoteVideo: store().remoteVideo,
      };
    };
    const freed = { audio: true, video: true, local: null, remote: null, remoteVideo: false };

    await connectedVideoCall();
    engine.hangUp();
    expect(released()).toEqual(freed);
    expect(media.keepAlive.stop).toHaveBeenCalled();
    engine.endCallForSignOut();

    await startVideoCall();
    event({ type: 'ended', status: 'rejected' });
    expect(released()).toEqual(freed);
    engine.endCallForSignOut();

    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await startVideoCall();
    await jest.advanceTimersByTimeAsync(45_000 + engine.CALL_TIMEOUTS.RING_GRACE_MS);
    expect(store().endReason).toBe('missed');
    expect(released()).toEqual(freed);
    jest.useRealTimers();
    engine.endCallForSignOut();

    await connectedVideoCall();
    await app.auth.useAuthStore.getState().logout();
    expect(released()).toEqual(freed);
    expect(store().phase).toBe('idle');
  });

  it('a connection failure during a video call ends it and frees the camera', async () => {
    await startVideoCall();
    event({ type: 'accepted' });
    await flush();
    pc().setConnectionState('failed');
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'failed' });
    expect(media.__state.streams[0].videoTrack.stopped).toBe(true);
    expect(localVideo()).toBeNull();
    await flush();
    expect(ends()).toEqual([{ reason: 'failed' }]);
  });

  it('records video calls as such in the history, from the call and from a missed note', async () => {
    const history = require('../src/calls/callHistory');
    await connectedVideoCall();
    engine.hangUp();
    await flush();
    server.missed = [
      {
        callId: VIDEO_CALL,
        callerUserId: PEER,
        kind: 'video',
        createdAt: CREATED,
        endedAt: EXPIRES,
      },
    ];
    await history.syncMissedCalls();
    const rows = await history.listCallLog();
    expect(rows.map((r) => [r.callId, r.kind, r.outcome]).sort()).toEqual(
      [
        [CALL_ID, 'video', 'answered'],
        [VIDEO_CALL, 'video', 'missed'],
      ].sort(),
    );
    const missed = history.describeCall(rows.find((r) => r.callId === VIDEO_CALL));
    expect(missed).toMatchObject({ video: true, title: 'Missed video call', kind: 'Missed' });
    expect(history.describeCall(rows.find((r) => r.callId === CALL_ID))).toMatchObject({
      video: true,
      title: 'Video call',
    });
  });

  it('a late remote track or media signal after the call ended changes nothing', async () => {
    await connectedVideoCall();
    const connection = pc();
    engine.hangUp();
    connection.emit('track', {
      track: { kind: 'video' },
      streams: [{ toURL: () => 'late', getTracks: () => [] }],
    });
    event({ type: 'signal', kind: 'media', video: true });
    await flush();
    expect(store()).toMatchObject({ remoteStreamUrl: null, remoteVideo: false });
    expect(connection.listenerCount()).toBe(0);
  });

  describe('video call screen', () => {
    let React;
    let act;
    let create;
    beforeEach(() => {
      React = require('react');
      ({ act, create } = require('react-test-renderer'));
    });

    async function renderScreen() {
      const Screen = require('../src/app/(app)/call').default;
      let tree;
      await act(async () => {
        tree = create(React.createElement(Screen));
      });
      await act(async () => flush());
      const has = (testID) => tree.root.findAllByProps({ testID }).length > 0;
      const labels = () =>
        tree.root
          .findAll((node) => node.props.accessibilityRole === 'button')
          .map((node) => node.props.accessibilityLabel);
      return { tree, act, has, labels };
    }

    it('shows both videos and the camera controls; hides their video for a locked chat', async () => {
      const messages = require('../src/messaging/messageStore');
      await messages.ensureConversation(PEER, { title: 'Bob', at: Date.now() });
      await connectedVideoCall();
      const { tree, act: run, has, labels } = await renderScreen();
      expect(has('remote-video')).toBe(true);
      expect(has('local-video')).toBe(true);
      expect(labels()).toEqual(
        expect.arrayContaining(['Camera off', 'Flip camera', 'Mute', 'Speaker', 'End call']),
      );

      await run(async () => engine.toggleCamera());
      expect(has('local-video')).toBe(false); // preview shows a camera-off placeholder
      expect(labels()).toContain('Camera on');
      await run(async () => {
        event({ type: 'signal', kind: 'media', video: false });
        await flush();
      });
      expect(has('remote-video')).toBe(false);
      expect(has('remote-camera-off')).toBe(true);
      await run(async () => tree.unmount());

      // Locked chat, not unlocked: their video is as identifying as their name.
      await messages.setConversationLocked(PEER, true);
      require('../src/security/chatLock').relockChats();
      await run(async () => {
        engine.toggleCamera(); // ours back on
        event({ type: 'signal', kind: 'media', video: true }); // theirs on again
        await flush();
      });
      const locked = await renderScreen();
      expect(locked.has('remote-video')).toBe(false);
      expect(locked.has('local-video')).toBe(true); // our own preview is fine
      await locked.act(async () => locked.tree.unmount());
    });

    it('an incoming video call offers Accept (video) / Decline and says it is a video call', async () => {
      videoInvite();
      const { tree, act: run, labels } = await renderScreen();
      expect(labels()).toEqual(expect.arrayContaining(['Decline', 'Accept']));
      expect(tree.root.findByProps({ testID: 'call-status' }).props.children).toBe(
        'Incoming video call',
      );
      await run(async () => tree.unmount());
    });
  });
});

describe('a call makes the other person a chat', () => {
  /** The chat list once it settles (creating and naming a chat spans several async hops). */
  const chats = async (until = () => true) => {
    const { listConversations } = require('../src/messaging/messageStore');
    let rows = [];
    for (let i = 0; i < 40; i += 1) {
      await flush();
      rows = await listConversations();
      if (rows.length > 0 && until(rows)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return rows;
  };

  it('an incoming call from someone new creates their chat, named from contacts when allowed', async () => {
    globalThis.__device.contacts = {
      status: 'granted',
      canAskAgain: true,
      grantOnRequest: true,
      book: [{ fullName: 'Bob', phones: [{ number: '+919876500001' }] }],
      requests: 0,
      reads: [],
    };
    server.contactMatches = [{ userId: PEER, phoneNumber: '+919876500001' }];
    invite();
    const [chat] = await chats((rows) => rows[0].title !== null);
    expect(chat).toMatchObject({ peerUserId: PEER, title: 'Bob' });
    expect(requests('POST /contacts/match')[0].body).toEqual({
      phoneNumbers: ['+919876500001'],
    });
    // The ringing screen picks the name up as soon as it is known.
    const React = require('react');
    const { act, create } = require('react-test-renderer');
    const Screen = require('../src/app/(app)/call').default;
    let tree;
    await act(async () => {
      tree = create(React.createElement(Screen));
    });
    await act(async () => flush());
    expect(tree.root.findByProps({ testID: 'call-peer-name' }).props.children).toBe('Bob');
    await act(async () => tree.unmount());
    globalThis.__device.contacts = undefined;
  });

  it('an outgoing call creates the chat too; without Contacts permission the name waits', async () => {
    globalThis.__device.contacts = undefined; // permission never asked
    await engine.startCall(PEER);
    engine.hangUp();
    const [chat] = await chats();
    expect(chat).toMatchObject({ peerUserId: PEER, title: null });
    expect(requests('POST /contacts/match')).toHaveLength(0); // never prompts, never uploads
    // Same person again: still one chat.
    invite();
    engine.declineCall();
    expect(await chats()).toHaveLength(1);
  });
});

describe('network changes during a call', () => {
  it('caller: a network switch while connected shows "Reconnecting…" and restarts ICE at once', async () => {
    await connectedOutgoingCall();
    expect(pc().offers).toBe(1);
    engine.handleCallNetworkChange();
    expect(store().phase).toBe('reconnecting');
    await flush();
    expect(pc().restarted).toBe(true);
    expect(pc().offers).toBe(2);
    expect(signals().filter((s) => s.kind === 'offer')).toHaveLength(2); // same call, same peer
    expect(signals().filter((s) => s.kind === 'offer')[1]).toMatchObject({ restart: 1 });
    expect(requests('POST /calls')).toHaveLength(1); // no second call was placed

    // The new path connects: back to connected, same timer (not restarted from zero).
    const { connectedAt } = store();
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer', restart: 1 });
    await flush();
    pc().setConnectionState('connected');
    expect(store()).toMatchObject({ phase: 'connected', connectedAt });

    // A second switch later may restart ICE again (one restart per drop, not per call).
    engine.handleCallNetworkChange();
    await flush();
    expect(pc().offers).toBe(3);
    expect(store().phase).toBe('reconnecting');
  });

  it('caller: a drop WebRTC reports itself also allows a restart after each recovery', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    pc().setConnectionState('disconnected');
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ICE_RESTART_AFTER_MS + 10);
    expect(pc().offers).toBe(2);
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer', restart: 1 });
    await flush();
    pc().setConnectionState('connected');
    expect(store().phase).toBe('connected');
    pc().setConnectionState('disconnected');
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ICE_RESTART_AFTER_MS + 10);
    expect(pc().offers).toBe(3); // restarted again
  });

  it('callee: a network switch shows "Reconnecting…" but leaves the ICE restart to the caller', async () => {
    invite();
    await engine.answerCall();
    await flush();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush();
    pc().setConnectionState('connected');
    engine.handleCallNetworkChange();
    expect(store().phase).toBe('reconnecting');
    await flush();
    expect(pc().restarted).toBeUndefined();
    expect(signals().filter((s) => s.kind === 'offer')).toHaveLength(0);
    // The caller's restart arrives as a new offer; answering it brings the call back.
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 2', restart: 1 });
    await flush();
    const answers = signals().filter((s) => s.kind === 'answer');
    expect(answers).toHaveLength(2);
    expect(answers[0].restart).toBeUndefined(); // the first answer is not a restart
    expect(answers[1]).toMatchObject({ restart: 1 }); // echoes which restart it answers
    pc().setConnectionState('connected');
    expect(store().phase).toBe('connected');
  });

  // WebRTC reports connection *changes* only (the fake above emits on every set, the real one
  // does not), so these tests change `connectionState` without an event where WebRTC would.
  it('caller: a network change the connection survives carries on (no event from WebRTC)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    const { connectedAt } = store();
    engine.handleCallNetworkChange(); // e.g. Wi-Fi joined while mobile data is still up
    expect(store().phase).toBe('reconnecting');
    await flush();
    // The restart completes silently.
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer', restart: 1 });
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.NETWORK_RECHECK_MS);
    expect(store()).toMatchObject({ phase: 'connected', connectedAt });
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RECONNECT_MS);
    expect(store().phase).toBe('connected');
    expect(ends()).toEqual([]);
    expect(pc().closed).toBe(false);
  });

  it('callee: a network change the connection survives does not end the call', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    invite();
    await engine.answerCall();
    await flush();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush();
    pc().setConnectionState('connected');
    engine.handleCallNetworkChange(); // the caller's side never noticed: no restart offer comes
    expect(store().phase).toBe('reconnecting');
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RECONNECT_MS + 10);
    expect(store().phase).toBe('connected');
    expect(ends()).toEqual([]);
  });

  it('the reconnect deadline never ends a call that WebRTC reports connected', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    engine.handleCallNetworkChange();
    pc().setConnectionState('disconnected');
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.NETWORK_RECHECK_MS);
    expect(store().phase).toBe('reconnecting'); // still down at the recheck
    pc().connectionState = 'connected'; // back on a new pair without a state event
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RECONNECT_MS);
    expect(store().phase).toBe('connected');
    expect(ends()).toEqual([]);
  });

  it('caller: an ICE-restart offer that cannot be sent is retried within the reconnect window', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    const serverFetch = global.fetch;
    let networkUp = false; // the first request on the new network does not get out
    global.fetch = jest.fn((url, init) =>
      !networkUp && url.endsWith('/signal')
        ? Promise.reject(new TypeError('Network request failed'))
        : serverFetch(url, init),
    );
    engine.handleCallNetworkChange();
    pc().setConnectionState('disconnected');
    await flush();
    expect(store().phase).toBe('reconnecting'); // not ended: the window is still open
    expect(signals().filter((s) => s.kind === 'offer')).toHaveLength(1);

    networkUp = true;
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.ICE_RESTART_AFTER_MS);
    expect(signals().filter((s) => s.kind === 'offer')).toHaveLength(2); // the restart got out
    // Restart 1 never got out; the retry is restart 2, and that is what gets answered.
    expect(signals().filter((s) => s.kind === 'offer')[1]).toMatchObject({ restart: 2 });
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer', restart: 2 });
    await flush();
    pc().setConnectionState('connected');
    expect(store().phase).toBe('connected');
    expect(ends()).toEqual([]);
  });

  it('caller: ICE-restart offers that never get out end the call at the deadline', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    const serverFetch = global.fetch;
    global.fetch = jest.fn((url, init) =>
      url.endsWith('/signal')
        ? Promise.reject(new TypeError('Network request failed'))
        : serverFetch(url, init),
    );
    engine.handleCallNetworkChange();
    pc().setConnectionState('disconnected');
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RECONNECT_MS + 10);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'connection_lost' });
    // Retried on a timer, not in a tight loop.
    const attempts = global.fetch.mock.calls.filter(([url]) => url.endsWith('/signal')).length;
    expect(attempts).toBeLessThanOrEqual(
      Math.ceil(engine.CALL_TIMEOUTS.RECONNECT_MS / engine.CALL_TIMEOUTS.ICE_RESTART_AFTER_MS) + 1,
    );
    await flush();
    expect(ends()).toEqual([{ reason: 'connection_lost' }]);
  });

  // Seen on devices: the answer to the caller's restart offer is published while the caller's
  // own Pusher socket is reconnecting after the same network change, and Pusher keeps no history.
  const offersSent = () => signals().filter((s) => s.kind === 'offer');

  it('caller: a restart answer lost while realtime reconnects is recovered by offering again', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    engine.handleCallNetworkChange(); // Wi-Fi → mobile data
    pc().setConnectionState('disconnected');
    await flush();
    expect(offersSent().at(-1)).toMatchObject({ restart: 1 });
    // Restart 1's answer never arrives.
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RESTART_ANSWER_MS);
    expect(offersSent()).toHaveLength(3);
    expect(offersSent().at(-1)).toMatchObject({ restart: 2 });
    expect(store().phase).toBe('reconnecting');
    // The other phone answers the new offer, and this answer arrives.
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer', restart: 2 });
    await flush();
    expect(pc().signalingState).toBe('stable');
    pc().setConnectionState('connected');
    expect(store().phase).toBe('connected');
    // Answered and connected: nothing is offered again.
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RECONNECT_MS);
    expect(offersSent()).toHaveLength(3);
    expect(ends()).toEqual([]);
  });

  it('caller: a late answer to an older restart offer is ignored; the current one applies', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    engine.handleCallNetworkChange();
    pc().setConnectionState('disconnected');
    await flush();
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RESTART_ANSWER_MS); // restart 2 out
    const applied = pc().remoteDescriptionCalls;
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 late answer', restart: 1 });
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 first answer again' }); // the first offer's
    await flush();
    expect(pc().remoteDescriptionCalls).toBe(applied); // neither matches the offer we hold
    expect(pc().signalingState).toBe('have-local-offer');
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer 2', restart: 2 });
    await flush();
    expect(pc().remoteDescriptionCalls).toBe(applied + 1);
    expect(pc().remoteDescription).toEqual({ type: 'answer', sdp: 'v=0 answer 2' });
  });

  it('caller: an answer that arrives before the offer request returns is not offered again', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    const serverFetch = global.fetch;
    const held = defer();
    global.fetch = jest.fn((url, init) =>
      url.endsWith('/signal') && JSON.parse(init.body).restart === 1
        ? held.promise.then(() => serverFetch(url, init))
        : serverFetch(url, init),
    );
    engine.handleCallNetworkChange();
    pc().setConnectionState('disconnected');
    await flush(); // restart offer set locally; its request is still in flight
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer', restart: 1 }); // realtime was faster
    await flush();
    expect(pc().signalingState).toBe('stable');
    held.resolve();
    await flush();
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RESTART_ANSWER_MS * 2);
    expect(pc().offers).toBe(2); // the initial offer and restart 1 only
  });

  it('caller: re-offers stop at the reconnect deadline, which ends the call', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    engine.handleCallNetworkChange();
    pc().setConnectionState('disconnected');
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RECONNECT_MS + 10);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'connection_lost' });
    const { RECONNECT_MS, RESTART_ANSWER_MS } = engine.CALL_TIMEOUTS;
    // The initial offer plus one restart per RESTART_ANSWER_MS inside the window, no more.
    expect(offersSent().length).toBeLessThanOrEqual(
      1 + Math.ceil(RECONNECT_MS / RESTART_ANSWER_MS),
    );
    const sentAtEnd = offersSent().length;
    await jest.advanceTimersByTimeAsync(RECONNECT_MS);
    expect(offersSent()).toHaveLength(sentAtEnd);
  });

  it('a network change outside a connected call changes nothing', async () => {
    engine.handleCallNetworkChange(); // no call
    expect(store().phase).toBe('idle');
    await engine.startCall(PEER); // ringing: nothing to restart yet
    engine.handleCallNetworkChange();
    expect(store().phase).toBe('outgoing');
    expect(media.__state.pcs).toHaveLength(0);
  });

  it('no recovery within the timeout ends the call as "Connection lost" and frees everything', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await connectedOutgoingCall();
    const connection = pc();
    engine.handleCallNetworkChange();
    connection.setConnectionState('disconnected'); // the old path is gone
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RECONNECT_MS + 10);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'connection_lost' });
    expect(connection.closed).toBe(true);
    expect(media.__state.streams[0].track.stopped).toBe(true);
    expect(media.keepAlive.stop).toHaveBeenCalled();
    await flush();
    expect(ends()).toEqual([{ reason: 'connection_lost' }]);
    // History says the call happened and then was lost, not that it is still going.
    const [entry] = await require('../src/calls/callHistory').listCallLog();
    expect(entry).toMatchObject({ outcome: 'answered' });
  });
});

describe('call security: attested DTLS fingerprints (engine logic; Signal is the test double)', () => {
  const signal = () => require('../src/crypto/signalService');
  const content = () => require('../src/messaging/content');
  const OTHER_CALL = '22222222-2222-4222-8222-222222222222';
  const OTHER = `sha-256 ${Array(32).fill('A7').join(':')}`;
  const withFingerprint = (sdp, fingerprint) => `${sdp}\r\na=fingerprint:${fingerprint}`;
  const decodeSent = (sent) =>
    content().decodeContent(new Uint8Array(Buffer.from(sent.attestation.body, 'base64'))).content;
  const typed = (value) => {
    const json = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
    return { type: 2, body: Buffer.concat([Buffer.from([0xff]), json]).toString('base64') };
  };
  const fakeTimers = () => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  const remoteDescriptionsApplied = () =>
    media.__state.pcs.reduce((n, p) => n + p.remoteDescriptionCalls, 0);
  const failedClosed = () =>
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'security_unverified' });

  async function acceptedCall() {
    await engine.startCall(PEER);
    event({ type: 'accepted' });
    await flush();
  }
  async function answering() {
    invite();
    await engine.answerCall();
    await flush();
  }
  async function pendingSecurityCode() {
    await require('../src/crypto/signalStore').recordIdentityChange(
      PEER,
      `${PEER}.1`,
      'b2xkLWtleQ==',
      'bmV3LWtleQ==',
    );
  }
  /** The server answers our next attestation requests with these errors, in order. */
  function attestationsRefused(...replies) {
    const serverFetch = global.fetch;
    global.fetch = jest.fn(async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (url.endsWith('/signal') && body?.kind === 'attest' && replies.length > 0) {
        const [status, code] = replies.shift();
        server.calls.push({ key: `POST /calls/${CALL_ID}/signal`, body });
        return {
          status,
          json: async () => ({ error: { code, message: code } }),
          headers: { get: () => null },
        };
      }
      return serverFetch(url, init);
    });
  }

  it('caller: attests ahead of its first offer, the same bytes with every copy (sealed once)', async () => {
    fakeTimers();
    await acceptedCall();
    expect(allSignals().map((body) => body.kind)).toEqual(['attest', 'offer']);
    const [first] = attestationsSent();
    expect(first).toMatchObject({ attestation: { type: 2 }, recipientRegistrationId: 4242 });
    expect(decodeSent(first)).toEqual({
      type: 'call.dtls',
      version: 1,
      callId: CALL_ID,
      role: 'caller',
      from: USER.id,
      to: PEER,
      kind: 'voice',
      fingerprints: [mockFingerprint],
    });

    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.RESTART_ANSWER_MS);
    await flush();
    expect(allSignals().map((body) => body.kind)).toEqual(['attest', 'offer', 'attest', 'offer']);
    expect(attestationsSent()[1]).toEqual(first);
    expect(signal().sealForPeer).toHaveBeenCalledTimes(1);
  });

  it('caller: the answer waits for the callee’s attestation and is applied once it verifies', async () => {
    await acceptedCall();
    event({ type: 'signal', kind: 'answer', sdp: 'v=0 answer' }, { attested: false });
    await flush();
    expect(remoteDescriptionsApplied()).toBe(0);
    expect(store().phase).toBe('connecting');

    attest();
    await flush();
    expect(pc().remoteDescription).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    pc().setConnectionState('connected');
    expect(store().phase).toBe('connected');
  });

  it('callee: the offer waits for the caller’s attestation; our answer follows our own', async () => {
    await answering();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' }, { attested: false });
    await flush();
    expect(remoteDescriptionsApplied()).toBe(0);
    expect(allSignals()).toEqual([]);

    attest();
    await flush();
    expect(remoteDescriptionsApplied()).toBe(1);
    expect(allSignals().map((body) => body.kind)).toEqual(['attest', 'answer']);
    expect(decodeSent(attestationsSent()[0])).toMatchObject({
      callId: CALL_ID,
      role: 'callee',
      from: USER.id,
      to: PEER,
    });
  });

  it('copies of a verified attestation are no-ops: decrypted once, the call carries on', async () => {
    await answering();
    attest();
    attest();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' }); // with its own copy
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1', restart: 1 }); // a P1 copy
    await flush();
    expect(signal().openFromPeer).toHaveBeenCalledTimes(1);
    expect(store().phase).toBe('connecting');
    expect(signals().filter((sig) => sig.kind === 'answer')).toHaveLength(2);
  });

  it.each([
    ['another call', { callId: OTHER_CALL }],
    ['the wrong role', { role: 'callee' }],
    ['another sender', { from: 'dddddddddddddddddddddddd' }],
    ['another recipient', { to: 'dddddddddddddddddddddddd' }],
    ['another kind of call', { kind: 'video' }],
  ])('an attestation bound to %s fails the call closed; nothing is applied', async (_, fields) => {
    await answering();
    attest(peerAttestation(CALL_ID, fields));
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' }, { attested: false });
    await flush();
    failedClosed();
    expect(remoteDescriptionsApplied()).toBe(0);
    expect(signals()).toEqual([]);
    expect(ends()).toEqual([{ reason: 'failed' }]);
  });

  it.each([
    ['not base64', { type: 2, body: 'not base64!' }],
    ['an unknown ciphertext type', { type: 1, body: 'AAAA' }],
    ['no ciphertext', null],
    [
      'a chat message',
      (() => {
        const bytes = require('../src/messaging/content').encodeContent({
          type: 'text',
          version: 1,
          text: 'hi',
        });
        return { type: 2, body: Buffer.from(bytes).toString('base64') };
      })(),
    ],
    [
      'raw text of an old app that looks like an attestation',
      { type: 2, body: Buffer.from('{"type":"call.dtls","version":1}').toString('base64') },
    ],
    ['an attestation of a later version', typed({ type: 'call.dtls', version: 2 })],
    [
      'an attestation with a SHA-1 fingerprint',
      typed({
        type: 'call.dtls',
        version: 1,
        callId: CALL_ID,
        role: 'caller',
        from: PEER,
        to: USER.id,
        kind: 'voice',
        fingerprints: [`sha-1 ${Array(20).fill('AB').join(':')}`],
      }),
    ],
  ])('%s instead of an attestation fails the call closed', async (_, attestation) => {
    await answering();
    attest(attestation);
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' }, { attested: false });
    await flush();
    failedClosed();
    expect(remoteDescriptionsApplied()).toBe(0);
  });

  it.each([
    ['a replay of a ciphertext decrypted before', 'DUPLICATE_MESSAGE', 'security_unverified'],
    ['an altered or forged ciphertext', 'SIGNAL_ERROR', 'security_unverified'],
    ['a changed security code', 'UNTRUSTED_IDENTITY', 'identity_changed'],
  ])('%s fails the call closed', async (_, code, reason) => {
    await answering();
    signal().openFromPeer.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: reason });
    expect(remoteDescriptionsApplied()).toBe(0);
  });

  it('a description with other fingerprints than the attested ones fails closed', async () => {
    await answering();
    attest();
    event({ type: 'signal', kind: 'offer', sdp: withFingerprint('v=0 offer', OTHER) });
    await flush();
    failedClosed();
    expect(remoteDescriptionsApplied()).toBe(0);
  });

  it('a later attestation with other fingerprints fails closed', async () => {
    await answering();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' });
    await flush();
    attest(peerAttestation(CALL_ID, { fingerprints: [OTHER] }));
    await flush();
    failedClosed();
  });

  it('ICE restarts keep the attested certificate: the same one recovers, another fails closed', async () => {
    fakeTimers();
    await connectedOutgoingCall();
    const restartAnswer = (fingerprint) => {
      const { restart } = signals()
        .filter((sig) => sig.kind === 'offer')
        .at(-1);
      event({
        type: 'signal',
        kind: 'answer',
        sdp: withFingerprint('v=0 answer', fingerprint),
        restart,
      });
    };

    engine.handleCallNetworkChange();
    pc().setConnectionState('disconnected');
    await flush();
    // The same certificate, spelled differently (algorithm case, lower-case hex): fine.
    restartAnswer(`SHA-256 ${mockFingerprint.split(' ')[1].toLowerCase()}`);
    await flush();
    expect(pc().remoteDescriptionCalls).toBe(2);
    pc().setConnectionState('connected');
    expect(store().phase).toBe('connected');

    engine.handleCallNetworkChange();
    pc().setConnectionState('disconnected');
    await flush();
    restartAnswer(OTHER);
    await flush();
    failedClosed();
    expect(pc().remoteDescriptionCalls).toBe(2);
  });

  it('no attestation by the negotiation deadline: “Couldn’t verify this call”, nothing applied', async () => {
    fakeTimers();
    await answering();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' }, { attested: false });
    await jest.advanceTimersByTimeAsync(engine.CALL_TIMEOUTS.NEGOTIATION_MS + 10);
    failedClosed();
    expect(remoteDescriptionsApplied()).toBe(0);
    await flush();
    expect(ends()).toEqual([{ reason: 'failed' }]);
  });

  it('a callee with new keys: one fresh Signal session, then the call goes on', async () => {
    attestationsRefused([409, 'STALE_RECIPIENT_DEVICE']);
    await acceptedCall();
    await flush();
    expect(signal().sealForPeer.mock.calls.map((call) => call[3])).toEqual([
      { fresh: false },
      { fresh: true },
    ]);
    expect(signals().map((sig) => sig.kind)).toEqual(['offer']);
    expect(store().phase).toBe('connecting');
  });

  it('refused again, or too large to relay: the call ends (no endless refreshing)', async () => {
    attestationsRefused([409, 'STALE_RECIPIENT_DEVICE'], [409, 'STALE_RECIPIENT_DEVICE']);
    await acceptedCall();
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'failed' });
    expect(signal().sealForPeer).toHaveBeenCalledTimes(2);
    expect(signals()).toEqual([]);
    engine.endCallForSignOut();

    attestationsRefused([413, 'PAYLOAD_TOO_LARGE']);
    await acceptedCall();
    await flush();
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'failed' });
  });

  it('a contact with a security code to review cannot be called; nothing is sent', async () => {
    await pendingSecurityCode();
    await engine.startCall(PEER);
    expect(store()).toMatchObject({ phase: 'ended', endReason: 'identity_changed' });
    expect(requests('POST /calls')).toHaveLength(0);
    expect(media.getMicrophone).not.toHaveBeenCalled();
    expect(await require('../src/calls/callHistory').listCallLog()).toEqual([]);
  });

  it('their call rings, but cannot be answered until the new security code is accepted', async () => {
    await pendingSecurityCode();
    invite();
    await flush();
    expect(store()).toMatchObject({ phase: 'incoming', identityChanged: true });
    await engine.answerCall();
    expect(store().phase).toBe('incoming');
    expect(requests(`POST /calls/${CALL_ID}/accept`)).toHaveLength(0);
    expect(media.getMicrophone).not.toHaveBeenCalled();

    const store_ = require('../src/crypto/signalStore');
    await store_.markIdentityChangeAccepted((await store_.getPendingIdentityChange(PEER)).id);
    await engine.answerCall();
    await flush();
    expect(store()).toMatchObject({ phase: 'connecting', identityChanged: false });
    expect(requests(`POST /calls/${CALL_ID}/accept`)).toHaveLength(1);
  });

  it('the call screen explains a changed security code and opens it for review', async () => {
    const React = require('react');
    const { act, create } = require('react-test-renderer');
    const { router } = require('expo-router');
    const Screen = require('../src/app/(app)/call').default;
    const render = async () => {
      let tree;
      await act(async () => {
        tree = create(React.createElement(Screen));
      });
      await act(async () => flush());
      return tree;
    };
    await pendingSecurityCode();

    invite();
    await flush();
    let tree = await render();
    expect(JSON.stringify(tree.toJSON())).toMatch(/Review it before answering/);
    await act(async () =>
      tree.root.findByProps({ testID: 'call-review-security-code' }).props.onPress(),
    );
    expect(router.push).toHaveBeenCalledWith(`/security-code/${PEER}`);
    expect(store().phase).toBe('incoming'); // still ringing behind it
    await act(async () => tree.unmount());
    engine.endCallForSignOut();

    await engine.startCall(PEER);
    tree = await render();
    expect(JSON.stringify(tree.toJSON())).toMatch(/Security code changed/);
    expect(JSON.stringify(tree.toJSON())).toMatch(/Review it before calling/);
    await act(async () => tree.root.findByProps({ testID: 'call-close' }).props.onPress());
    expect(store().phase).toBe('idle');
    await act(async () => tree.unmount());
  });

  it('another call’s attestation, or one arriving after the call ended, is never processed', async () => {
    await answering();
    attest(peerAttestation(OTHER_CALL), OTHER_CALL);
    await flush();
    expect(signal().openFromPeer).not.toHaveBeenCalled();
    expect(store().phase).toBe('connecting');

    event({ type: 'ended', status: 'ended', reason: 'hangup' });
    attest();
    event({ type: 'signal', kind: 'offer', sdp: 'v=0 offer 1' }, { attested: false });
    await flush();
    expect(signal().openFromPeer).not.toHaveBeenCalled();
    expect(remoteDescriptionsApplied()).toBe(0);
  });
});
