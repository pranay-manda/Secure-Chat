import {
  CALL_EVENT,
  CALL_KIND,
  CALL_LIMITS,
  CALL_STATUS,
  ERROR_CODE,
} from '@secure-chat/shared/constants';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { loadSession } from '../auth/tokenStore';
import { ENDPOINTS } from '../config/endpoints';
import { nameConversationsFromContacts } from '../contacts/contactDiscovery';
import { getPendingIdentityChange, openFromPeer, sealForPeer } from '../crypto/signalService';
import { ApiError, apiRequest, NetworkError } from '../lib/api';
import { encodeContent } from '../messaging/content';
import { ensureConversation, UNTRUSTED_IDENTITY } from '../messaging/messageStore';
import { dismissCallNotifications } from '../notifications/pushNotifications';
import { deleteMeta, getMeta, setMeta } from '../db/database';
import { bumpCallRevision, CALL_OUTCOME, callOutcome, recordCall } from './callHistory';
import { CALL_INPUT, CALL_PHASE, END_REASON, isActivePhase, nextPhase } from './callMachine';
import {
  attestationContent,
  canonicalCiphertext,
  parseFingerprints,
  sameFingerprints,
  verifyAttestation,
} from './callSecurity';
import { ICE_ROUTE } from './ice';
import * as media from './media';

/**
 * 1:1 voice and video calls on this phone.
 *
 * Signaling (invite, accept, SDP offer/answer, ICE candidates, camera on/off, attestations, end)
 * goes through our API, which authorizes it and relays it to the other phone's own Pusher
 * channel. Audio and video flow directly between the phones over WebRTC (DTLS-SRTP); the server
 * never carries them. A video call is a voice call whose local stream also has a camera track;
 * the phases, timers and recovery are the same for both. The DTLS keys that protect the media
 * are authenticated end to end: each phone proves its certificate's fingerprint to the other
 * through Signal (see "Call security" below and callSecurity.js), so a remote description is
 * applied only if it carries the fingerprints the other person's own phone attested.
 *
 * Every phase change goes through the state machine (callMachine.js), so late, duplicate or
 * replayed events are ignored, and cleanup is idempotent (ending twice is harmless).
 */

export const CALL_TIMEOUTS = Object.freeze({
  /** Added to the server's ring window before this phone gives up on its own. */
  RING_GRACE_MS: 2_000,
  /** From "answered" to audio flowing (SDP exchange + ICE). */
  NEGOTIATION_MS: 20_000,
  /** How long a dropped connection may try to recover before the call ends. */
  RECONNECT_MS: 15_000,
  /** The caller restarts ICE this long after the connection dropped (network switch). */
  ICE_RESTART_AFTER_MS: 2_000,
  /**
   * After a network change, if WebRTC still reports the connection up this long afterwards, the
   * media path survived the change (e.g. mobile data stays up for a while after Wi-Fi joins).
   */
  NETWORK_RECHECK_MS: 5_000,
  /**
   * An ICE-restart offer still unanswered after this long is offered again. Its answer travels
   * over the realtime connection, which is often itself reconnecting after the same network
   * change, and Pusher keeps no history: a lost answer would otherwise end the call.
   */
  RESTART_ANSWER_MS: 4_000,
  /** Development builds: how often the connection-path label is re-read while connected. */
  ROUTE_REFRESH_MS: 5_000,
  /** While connected, how often the in-progress marker's "still alive" time is refreshed. */
  ALIVE_MARK_MS: 15_000,
  /**
   * While a call rings (either side), how often the server's view of it is checked: covers a
   * lost "accepted", "ended" or "invite" event (Pusher keeps no history).
   */
  RING_CHECK_MS: 5_000,
  /** Backoff before re-sending an offer or answer whose request got no response at all. */
  SIGNAL_RETRY_MS: Object.freeze([2_000, 4_000]),
  /** ICE candidates are sent in small batches instead of one request each. */
  CANDIDATE_BATCH_MS: 150,
  /** How long the end reason stays on screen before going back to idle. */
  ENDED_DISPLAY_MS: 2_500,
  /** A missing permission is explained (with "Open Settings") for this long unless closed. */
  PERMISSION_NOTICE_MS: 15_000,
});

const P = CALL_PHASE;
const I = CALL_INPUT;

const INITIAL = Object.freeze({
  phase: P.IDLE,
  callId: null,
  peerUserId: null,
  direction: null,
  /** CALL_KIND: voice | video. */
  kind: CALL_KIND.VOICE,
  muted: false,
  speaker: false,
  connectedAt: null,
  endReason: null,
  /** Ended on a refused permission the system will no longer ask for: only Settings helps. */
  permissionBlocked: false,
  /** Network path of the connected call (ICE_ROUTE: host | reflexive | relay); no addresses. */
  route: null,
  // Video calls only.
  /** Our camera: off by the user's choice. */
  cameraOff: false,
  /** Our camera could not be used (permission refused when answering): audio only. */
  cameraUnavailable: false,
  /** Which camera we send: 'user' (front) or 'environment' (back). */
  facing: 'user',
  /** Whether the other phone is sending video (their camera on). */
  remoteVideo: false,
  /** Stream handles for RTCView (opaque ids, no media): our camera and theirs. */
  localStreamUrl: null,
  remoteStreamUrl: null,
  /** Incoming call from someone whose new security code is not reviewed yet: cannot answer. */
  identityChanged: false,
});

/** What the UI shows. Never contains SDP, candidates, addresses or TURN credentials. */
export const useCallStore = create(() => ({ ...INITIAL }));

/** Store fields that describe one call and must start fresh with each. */
const freshCallState = (kind) => ({
  kind,
  muted: false,
  speaker: kind === CALL_KIND.VIDEO, // video is watched at arm's length
  connectedAt: null,
  endReason: null,
  permissionBlocked: false,
  route: null,
  cameraOff: false,
  cameraUnavailable: false,
  facing: 'user',
  remoteVideo: false,
  localStreamUrl: null,
  remoteStreamUrl: null,
  identityChanged: false,
});

/** The current call's private context (peer connection, stream, timers, queues). */
let session = null;
let resetTimer = null;
/** Calls this phone already finished: a late invite or recovery read never revives them. */
const finishedCalls = new Set();
/**
 * Bumped whenever this phone's call changes: a call starts ringing or is dialled, an outgoing
 * call gets its id from the server, a call ends, or the user signs out. A read of the server's
 * call state that started before a change describes an earlier state (see runReconcile).
 */
let callEpoch = 0;

const phase = () => useCallStore.getState().phase;
const isCurrent = (s) => s !== null && session === s && !s.closed;

function newSession({ direction, peerUserId, callId = null, kind = CALL_KIND.VOICE }) {
  return {
    direction,
    peerUserId,
    callId,
    kind,
    startedAt: Date.now(), // dialled / started ringing (call history)
    connectedAt: null, // audio first connected
    iceServers: null,
    iceTransportPolicy: null, // 'relay' = media only through TURN (set by the API)
    pc: null,
    stream: null, // microphone (and the camera, until the camera is first released)
    cameraStream: null, // a camera reopened after the app had left the screen
    videoSender: null, // the RTCRtpSender carrying our camera track
    remoteStream: null,
    facing: 'user',
    videoPausedInBackground: false, // our camera was released because the app left the screen
    cameraTask: null, // the camera release/reopen in progress (they run one at a time)
    timers: new Map(),
    listeners: [],
    early: [], // events for our outgoing call that arrived before POST /calls returned
    pendingSignals: [], // signaling that arrived before the peer connection existed
    pendingCandidates: [], // remote candidates that arrived before the remote description
    remoteDescriptionSet: false,
    sentCandidates: new Set(),
    receivedCandidates: new Set(),
    outgoingCandidates: [],
    signalChain: Promise.resolve(),
    iceRestarted: false,
    // Offer numbers: 0 = the first offer; every later offer (a re-sent first offer, or an ICE
    // restart) takes the next number, and only the answer echoing the latest one is applied.
    restartGen: 0, // caller: number of the latest offer sent (its answer must echo it)
    offerSdp: null, // caller: the first offer as created (fallback if the local one is unknown)
    offerGen: -1, // callee: restart number of the newest offer applied (the first offer is 0)
    generationCandidates: 0, // remote candidates accepted since the last remote description
    // Call security (see below): each phone attests its DTLS fingerprints through Signal.
    attestation: null, // promise of our sealed attestation: sealed once, re-sent byte for byte
    sessionRefreshed: false, // the one fresh Signal session allowed after STALE_RECIPIENT_DEVICE
    peerFingerprints: null, // the other phone's attested fingerprint set, once verified
    verifiedAttestations: new Set(), // canonical ciphertexts already verified (copies: no-ops)
    heldDescriptions: [], // offers/answers that arrived before the attestation (bounded)
    closed: false,
  };
}

/** Applies a state-machine input; returns false (and changes nothing) if it does not fit. */
function move(input, patch = {}) {
  const next = nextPhase(phase(), input);
  if (!next) return false;
  useCallStore.setState({ ...patch, phase: next });
  return true;
}

function setTimer(s, name, ms, fn) {
  clearTimeout(s.timers.get(name));
  s.timers.set(
    name,
    setTimeout(() => {
      s.timers.delete(name);
      if (isCurrent(s)) fn();
    }, ms),
  );
}

function clearTimer(s, name) {
  clearTimeout(s.timers.get(name));
  s.timers.delete(name);
}

const stopStream = (stream) => stream?.getTracks?.().forEach((track) => track.stop());

/** Tells the server the call is over. Best effort: the server also times calls out. */
function notifyEnd(callId, reason) {
  if (!callId) return;
  apiRequest('POST', ENDPOINTS.CALLS.end(callId), { body: { reason } }).catch(() => {});
}

/** Releases everything of a call exactly once: timers, peer connection, microphone, audio. */
function cleanup(s) {
  if (s.closed) return;
  s.closed = true;
  for (const timer of s.timers.values()) clearTimeout(timer);
  s.timers.clear();
  for (const [event, handler] of s.listeners) s.pc?.removeEventListener?.(event, handler);
  s.listeners = [];
  try {
    s.pc?.close();
  } catch {
    // Already closed.
  }
  s.pc = null;
  stopStream(s.stream); // microphone and camera are released here
  s.stream = null;
  stopStream(s.cameraStream);
  s.cameraStream = null;
  s.videoSender = null;
  stopStream(s.remoteStream);
  s.remoteStream = null;
  useCallStore.setState({ localStreamUrl: null, remoteStreamUrl: null, remoteVideo: false });
  s.pendingSignals = [];
  s.pendingCandidates = [];
  s.outgoingCandidates = [];
  media.keepAlive.stop();
  media.audio.stopRingtone();
  media.audio.stop();
  if (s.callId) {
    finishedCalls.add(s.callId);
    dismissCallNotifications(s.callId).catch?.(() => {});
  }
  if (session === s) {
    session = null;
    callEpoch += 1;
  }
}

/**
 * Whoever we call or are called by gets a chat (so they appear in Chats, not only in Calls),
 * named from the address book right away when Contacts permission was granted. Local only and
 * best effort: a failure here never affects the call.
 */
function rememberPeer(s) {
  ensureConversation(s.peerUserId, { at: s.startedAt })
    .then(() => nameConversationsFromContacts())
    .then(() => bumpCallRevision())
    .catch(() => {});
}

/** Adds the finished call to this phone's call history (best effort, never blocks the UI). */
function logCall(s, reason) {
  const outcome = callOutcome({ direction: s.direction, reason, connected: s.connectedAt != null });
  // The call is recorded (or deliberately not, e.g. sign-out): its in-progress marker can go.
  const done = () => (s.connectedAt != null ? clearInProgress() : undefined);
  if (!outcome || !s.peerUserId) {
    done();
    return;
  }
  recordCall({
    callId: s.callId,
    peerUserId: s.peerUserId,
    direction: s.direction,
    kind: s.kind,
    outcome,
    startedAt: s.startedAt,
    connectedAt: s.connectedAt,
    endedAt: Date.now(),
  })
    .then(done)
    .catch(() => {});
}

// --- Calls interrupted by the app being killed ----------------------------------------------
//
// A connected call is remembered in the encrypted local database (`meta`, wiped with it on
// sign-out) until it is recorded in the history. If the app is killed or crashes mid-call,
// nothing records it then; the marker is still there at the next start and becomes an
// "interrupted" history entry. A call cannot outlive this app's process (its WebRTC connection
// lives in it), so a marker found when no call is running here is always an interrupted call.
// The server is not involved: it keeps no history of answered calls, by design.

const IN_PROGRESS_KEY = 'calls.inProgress';

function markInProgress(s) {
  const marker = {
    callId: s.callId,
    peerUserId: s.peerUserId,
    direction: s.direction,
    kind: s.kind,
    startedAt: s.startedAt,
    connectedAt: s.connectedAt,
    aliveAt: Date.now(), // refreshed while the call lasts: the best known end time
  };
  setMeta(IN_PROGRESS_KEY, JSON.stringify(marker)).catch(() => {});
}

function clearInProgress() {
  return deleteMeta(IN_PROGRESS_KEY).catch(() => {});
}

/** While connected, the marker's `aliveAt` is kept roughly current. */
function keepMarkerAlive(s) {
  setTimer(s, 'alive', CALL_TIMEOUTS.ALIVE_MARK_MS, () => {
    markInProgress(s);
    keepMarkerAlive(s);
  });
}

/**
 * At start (no call running here): records a call the app was killed during, once. Idempotent:
 * a call already in the history (recorded just before the kill) is not added again.
 *
 * @returns {Promise<boolean>} whether an interrupted call was found
 */
export async function recoverInterruptedCall() {
  if (session) return false; // a call is running in this process: nothing was interrupted
  let marker = null;
  try {
    marker = JSON.parse((await getMeta(IN_PROGRESS_KEY)) ?? 'null');
  } catch {
    marker = null; // unreadable: dropped below
  }
  const valid =
    typeof marker?.callId === 'string' &&
    typeof marker.peerUserId === 'string' &&
    Number.isFinite(marker.startedAt) &&
    Number.isFinite(marker.connectedAt);
  if (valid && !session) {
    await recordCall({
      callId: marker.callId,
      peerUserId: marker.peerUserId,
      direction: marker.direction === 'incoming' ? 'incoming' : 'outgoing',
      kind: marker.kind === CALL_KIND.VIDEO ? CALL_KIND.VIDEO : CALL_KIND.VOICE,
      outcome: CALL_OUTCOME.INTERRUPTED,
      startedAt: marker.startedAt,
      connectedAt: marker.connectedAt,
      endedAt: Number.isFinite(marker.aliveAt) ? marker.aliveAt : marker.connectedAt,
    });
    finishedCalls.add(marker.callId); // a late event for it never revives it
  }
  await clearInProgress();
  return valid;
}

/** Ends the call on this phone (no server request) and shows `reason` briefly. Idempotent. */
/** Endings the user has to act on (a permission to grant): shown until closed, or longer. */
const NEEDS_ACTION = new Set([
  END_REASON.PERMISSION_DENIED,
  END_REASON.CAMERA_DENIED,
  END_REASON.MEDIA_UNAVAILABLE,
  END_REASON.IDENTITY_CHANGED,
]);

function finish(s, reason, patch = {}) {
  if (!isCurrent(s)) return;
  cleanup(s);
  logCall(s, reason);
  move(I.END, { endReason: reason, ...patch });
  clearTimeout(resetTimer);
  resetTimer = setTimeout(
    () => {
      if (move(I.RESET)) useCallStore.setState({ ...INITIAL });
    },
    NEEDS_ACTION.has(reason) ? CALL_TIMEOUTS.PERMISSION_NOTICE_MS : CALL_TIMEOUTS.ENDED_DISPLAY_MS,
  );
}

/** Closes the ended-call screen now (its Close / Open Settings buttons). */
export function dismissEndedCall() {
  if (phase() === P.ENDED) resetNow();
}

/** Ends the call because something failed, telling the server too. */
function fail(s, reason) {
  if (!isCurrent(s)) return;
  notifyEnd(s.callId, reason === END_REASON.CONNECTION_LOST ? 'connection_lost' : 'failed');
  finish(s, reason);
}

function resetNow() {
  clearTimeout(resetTimer);
  useCallStore.setState({ ...INITIAL });
}

function startReason(err) {
  if (err instanceof ApiError) {
    if (err.code === ERROR_CODE.CALLEE_BUSY) return END_REASON.BUSY;
    if (err.code === ERROR_CODE.ALREADY_IN_CALL) return END_REASON.ALREADY_IN_CALL;
    if (err.code === ERROR_CODE.CALLEE_UNAVAILABLE) return END_REASON.UNAVAILABLE;
  }
  return END_REASON.FAILED;
}

/** Ring window from the server's own timestamps (immune to this phone's clock being off). */
const isRinging = () => phase() === P.OUTGOING || phase() === P.INCOMING;

/**
 * While the call rings, checks the server's view of it every RING_CHECK_MS (P4): an "accepted"
 * or "ended" event lost on the way (Pusher keeps no history) would otherwise leave this phone
 * ringing or calling until its own timeout. Only while ringing and while this is the current
 * call (setTimer drops it otherwise); one request at a time (reconcileCall is single-flight),
 * the next armed only after it finished; gone with the call's timers when the call ends.
 */
function armRingCheck(s) {
  setTimer(s, 'ringCheck', CALL_TIMEOUTS.RING_CHECK_MS, () => {
    if (!isRinging()) return;
    reconcileCall().finally(() => {
      if (isCurrent(s) && isRinging()) armRingCheck(s);
    });
  });
}

/** Arms the ring timeout; returns how long this phone lets it ring (ms). */
function armRingTimeout(s, { createdAt, ringExpiresAt }) {
  const windowMs = Math.max(0, Date.parse(ringExpiresAt) - Date.parse(createdAt)) || 45_000;
  const ringMs = windowMs + CALL_TIMEOUTS.RING_GRACE_MS;
  setTimer(s, 'ring', ringMs, () => {
    if (s.direction === 'outgoing') notifyEnd(s.callId, 'timeout');
    finish(s, END_REASON.MISSED);
  });
  return ringMs;
}

// --- WebRTC -------------------------------------------------------------------------------

function listen(s, event, handler) {
  s.pc.addEventListener(event, handler);
  s.listeners.push([event, handler]);
}

function openPeerConnection(s) {
  s.pc = media.createPeerConnection(s.iceServers ?? [], {
    iceTransportPolicy: s.iceTransportPolicy,
  });
  for (const stream of [s.stream, s.cameraStream]) {
    for (const track of stream?.getTracks?.() ?? []) {
      const sender = s.pc.addTrack(track, stream);
      if (track.kind === 'video') s.videoSender = sender ?? null;
    }
  }
  listen(s, 'icecandidate', (event) => onLocalCandidate(s, event?.candidate));
  listen(s, 'connectionstatechange', () => onConnectionState(s, s.pc?.connectionState));
  // Remote audio plays automatically on React Native once its track arrives; remote video
  // needs a view, so its stream is handed to the UI.
  listen(s, 'track', (event) => onRemoteTrack(s, event));
}

function onRemoteTrack(s, event) {
  if (!isCurrent(s) || event?.track?.kind !== 'video') return;
  const stream = event.streams?.[0];
  if (!stream) return;
  s.remoteStream = stream;
  useCallStore.setState({
    remoteStreamUrl: stream.toURL?.() ?? null,
    // Until the other phone says otherwise, a video track means their camera is on.
    remoteVideo: s.remoteVideoFlag ?? true,
  });
}

/** Tells the other phone whether our camera is sending (a flag only; never media). */
function sendMediaState(s) {
  if (!s.callId || !s.pc || s.kind !== CALL_KIND.VIDEO) return;
  const video = localVideoTrack(s)?.enabled === true;
  sendSignal(s, { kind: 'media', video }).catch(() => {});
}

const localVideoTrack = (s) =>
  s.cameraStream?.getVideoTracks?.()[0] ?? s.stream?.getVideoTracks?.()[0] ?? null;

/**
 * Stops the camera and sends nothing in its place (the sender stays, so no renegotiation).
 * Android closes a backgrounded app's camera anyway; releasing it ourselves keeps the state
 * honest and the camera indicator off while the user is elsewhere.
 */
async function releaseCamera(s) {
  const track = localVideoTrack(s);
  if (!track) return;
  track.stop();
  s.stream?.removeTrack?.(track);
  if (s.cameraStream) {
    stopStream(s.cameraStream);
    s.cameraStream = null;
  }
  useCallStore.setState({ localStreamUrl: null });
  try {
    await s.videoSender?.replaceTrack?.(null);
  } catch {
    // Nothing is sent on a stopped track anyway.
  }
}

/**
 * Runs camera releases and reopens one after another, never side by side: two captures of the
 * same camera evict each other, and on some phones (seen on Android 16) that left WebRTC's
 * capture thread stuck, so no camera or microphone could start again until the app restarted.
 * A failure (camera gone, permission revoked) leaves the call on audio.
 */
function cameraTask(s, task) {
  s.cameraTask = (s.cameraTask ?? Promise.resolve()).then(task).catch(() => {});
  return s.cameraTask;
}

/** Reopens the camera and swaps the new track into the existing sender. */
async function acquireCamera(s) {
  const stream = await media.getMedia({ audio: false, video: true, facing: s.facing });
  const track = stream.getVideoTracks?.()[0];
  if (!isCurrent(s) || !track || localVideoTrack(s)) {
    stopStream(stream); // over, or a camera appeared meanwhile
    return;
  }
  s.cameraStream = stream;
  track.enabled = !useCallStore.getState().cameraOff;
  if (s.videoSender) await s.videoSender.replaceTrack(track);
  else if (s.pc) s.videoSender = s.pc.addTrack(track, stream) ?? null;
  if (isCurrent(s)) useCallStore.setState({ localStreamUrl: stream.toURL?.() ?? null });
}

async function sendSignal(s, body) {
  await apiRequest('POST', ENDPOINTS.CALLS.signal(s.callId), { body });
}

/** Delay before retry number `failures` (1, 2, ...) of a request that got no response. */
const retryDelay = (failures) =>
  CALL_TIMEOUTS.SIGNAL_RETRY_MS[
    Math.min(Math.max(failures, 1), CALL_TIMEOUTS.SIGNAL_RETRY_MS.length) - 1
  ];

/**
 * A signaling request failed. No response at all (offline, DNS, timeout) is transient: `retry`
 * with the next failure count. Anything else is final: the server rejected it (e.g. the call
 * ended), the session is gone, the request was invalid, or our attestation could not be made
 * (a changed security code, our own description without a usable fingerprint).
 */
function onSignalSendError(s, err, failures, retry) {
  if (!isCurrent(s)) return;
  if (err instanceof NetworkError) retry(failures + 1);
  else fail(s, failureReason(err));
}

const failureReason = (err) => {
  if (err?.code === UNTRUSTED_IDENTITY) return END_REASON.IDENTITY_CHANGED;
  if (err?.code === SECURITY_FAILURE) return END_REASON.SECURITY_UNVERIFIED;
  return END_REASON.FAILED;
};

// --- Call security: DTLS fingerprints attested through Signal (R2) -------------------------
//
// libwebrtc accepts the other phone's DTLS certificate only if it matches a fingerprint in the
// remote description, so whoever could change that description (our server, Pusher) could
// otherwise sit in the middle of the call. Each phone therefore attests its own fingerprints
// (callSecurity.js): bound to the call, its direction, both people and the kind, encrypted on
// the regular Signal session with the other person, and sent as an `attest` signal ahead of its
// first offer (caller) or answer (callee) and again, byte for byte, with every copy or retry.
// The receiver applies a remote description only once that attestation verified and only if the
// description's fingerprints are exactly the attested ones; until then it is held. Who sent an
// attestation is proven by the Signal session that decrypts it, never by the server.
//
// Failing closed: an attestation that is malformed, bound to another call, person, role or
// kind, that cannot be decrypted (including a replay of a ciphertext decrypted before), that
// brings other fingerprints than an earlier one, or a description with other fingerprints ends
// the call ("Couldn't verify this call"); a changed security code ends it as such. A copy of an
// attestation already verified in this call is recognised (canonical ciphertext) and ignored:
// it is never decrypted twice. Nothing about attestations is stored or logged.

/** Error code of a call-security failure on our side (no usable local fingerprint). */
const SECURITY_FAILURE = 'CALL_SECURITY_FAILURE';
/** Remote descriptions kept while the attestation is awaited (newest kept). */
const HELD_DESCRIPTIONS_MAX = 8;

const myUserId = async () => (await loadSession())?.user?.id ?? null;
const roleOf = (s) => (s.direction === 'outgoing' ? 'caller' : 'callee');

function securityFailure() {
  const err = new Error('The call could not be secured');
  err.code = SECURITY_FAILURE;
  return err;
}

/**
 * Our sealed attestation for this call, made once from our own local description (the
 * certificate the other phone's libwebrtc will check). Kept and re-sent as is; made again only
 * if sealing failed (nothing was sent) or with `fresh` (a new Signal session, see below).
 */
function ourAttestation(s, { fresh = false } = {}) {
  if (s.attestation && !fresh) return s.attestation;
  const sealing = (async () => {
    const local = parseFingerprints(s.pc?.localDescription?.sdp);
    const me = await myUserId();
    if (!local.ok || !me) throw securityFailure();
    const content = attestationContent({
      callId: s.callId,
      role: roleOf(s),
      from: me,
      to: s.peerUserId,
      kind: s.kind,
      fingerprints: local.fingerprints,
    });
    return sealForPeer(me, s.peerUserId, encodeContent(content), { fresh });
  })();
  s.attestation = sealing;
  sealing.catch(() => {
    if (s.attestation === sealing) s.attestation = null;
  });
  return sealing;
}

const attestSignal = (sealed) => ({
  kind: 'attest',
  attestation: { type: sealed.type, body: sealed.body },
  ...(sealed.recipientRegistrationId != null && {
    recipientRegistrationId: sealed.recipientRegistrationId,
  }),
});

/**
 * Sends our attestation. If the server says the other phone registered new keys since our
 * Signal session was built (it signed in again or was reinstalled), the session is rebuilt once
 * from its new key bundle and the attestation sealed again on it; a changed security code stops
 * there. A second refusal, like any other failure, goes to the caller's error handling.
 */
async function sendAttestation(s) {
  try {
    await sendSignal(s, attestSignal(await ourAttestation(s)));
  } catch (err) {
    const stale = err instanceof ApiError && err.code === ERROR_CODE.STALE_RECIPIENT_DEVICE;
    if (!stale || s.sessionRefreshed || !isCurrent(s)) throw err;
    s.sessionRefreshed = true;
    await sendSignal(s, attestSignal(await ourAttestation(s, { fresh: true })));
  }
}

/**
 * The other phone's attestation (an `attest` signal), applied in signaling order. On success
 * its fingerprints become the only ones a remote description may carry, and descriptions held
 * meanwhile are applied in arrival order.
 */
async function acceptAttestation(s, signal) {
  const ciphertext = canonicalCiphertext(signal.attestation);
  if (!ciphertext) {
    fail(s, END_REASON.SECURITY_UNVERIFIED);
    return;
  }
  // The same ciphertext again (sent with every offer copy and answer): already verified.
  if (s.verifiedAttestations.has(ciphertext.body)) return;
  const me = await myUserId();
  let decoded;
  try {
    decoded = await openFromPeer(
      me,
      { userId: s.peerUserId, deviceId: signal.senderDeviceId },
      ciphertext,
    );
  } catch (err) {
    // Not decryptable on our session with them (forged, altered, for other keys), a replay of
    // a ciphertext decrypted before (never a copy of a verified one: those stop above), or a
    // changed security code.
    if (isCurrent(s)) {
      fail(
        s,
        err?.code === UNTRUSTED_IDENTITY
          ? END_REASON.IDENTITY_CHANGED
          : END_REASON.SECURITY_UNVERIFIED,
      );
    }
    return;
  }
  if (!isCurrent(s)) return;
  const verdict = verifyAttestation(decoded, {
    callId: s.callId,
    role: s.direction === 'outgoing' ? 'callee' : 'caller',
    from: s.peerUserId,
    to: me,
    kind: s.kind,
  });
  if (
    !verdict.ok ||
    (s.peerFingerprints && !sameFingerprints(verdict.fingerprints, s.peerFingerprints))
  ) {
    fail(s, END_REASON.SECURITY_UNVERIFIED);
    return;
  }
  s.peerFingerprints = verdict.fingerprints;
  s.verifiedAttestations.add(ciphertext.body);
  for (const held of s.heldDescriptions.splice(0)) {
    if (!isCurrent(s)) return;
    await applySignal(s, held);
  }
}

/**
 * Whether a remote description may be applied now: only after the other phone's attestation
 * verified, and only with exactly the attested fingerprints. Before that it waits (held);
 * with any other fingerprint set the call fails closed.
 */
function admitDescription(s, signal) {
  if (!s.peerFingerprints) {
    if (s.heldDescriptions.length >= HELD_DESCRIPTIONS_MAX) s.heldDescriptions.shift();
    s.heldDescriptions.push(signal);
    return false;
  }
  const remote = parseFingerprints(signal.sdp);
  if (remote.ok && sameFingerprints(remote.fingerprints, s.peerFingerprints)) return true;
  fail(s, END_REASON.SECURITY_UNVERIFIED);
  return false;
}

// --- Initial negotiation: the caller's offer until it is answered (P1, P2) -----------------
//
// Pusher keeps no history: an offer published while the callee's socket is not subscribed yet
// (e.g. it just answered from a notification) or an answer published while the caller's socket
// reconnects is gone. The caller therefore sends its first offer again, every RESTART_ANSWER_MS
// while it is unanswered, until the negotiation deadline (NEGOTIATION_MS) ends the attempt.
// Each copy is the same local offer (no new createOffer: same ICE credentials, and the local
// description includes the candidates gathered so far, so lost candidate batches ride along)
// under the next offer number. The callee answers each newer number once; the caller applies
// only the answer to its latest number, so late or duplicate answers are ignored.

/** Still waiting for the answer to our first offer (and nothing else has happened since). */
const awaitingFirstAnswer = (s) =>
  isCurrent(s) &&
  s.direction === 'outgoing' &&
  phase() === P.CONNECTING &&
  s.pc?.signalingState === 'have-local-offer' &&
  !s.remoteDescriptionSet;

async function sendFirstOffer(s) {
  let offer;
  try {
    offer = await s.pc.createOffer({});
    if (!isCurrent(s)) return;
    await s.pc.setLocalDescription(offer);
    if (!isCurrent(s)) return;
  } catch {
    fail(s, END_REASON.FAILED); // a local WebRTC failure: final
    return;
  }
  s.offerSdp = offer.sdp;
  transmitFirstOffer(s, offer.sdp, 0, 0);
}

/**
 * Sends offer number `gen` (0 = first copy), preceded by our attestation (the same one every
 * time), then waits for its answer or retries.
 */
function transmitFirstOffer(s, sdp, gen, failures) {
  sendAttestation(s)
    .then(() => sendSignal(s, { kind: 'offer', sdp, ...(gen > 0 && { restart: gen }) }))
    .then(
      () => scheduleFirstOfferCopy(s, CALL_TIMEOUTS.RESTART_ANSWER_MS, 0),
      (err) =>
        onSignalSendError(s, err, failures, (n) => scheduleFirstOfferCopy(s, retryDelay(n), n)),
    );
}

function scheduleFirstOfferCopy(s, delayMs, failures) {
  if (!awaitingFirstAnswer(s)) return;
  setTimer(s, 'offerResend', delayMs, () => {
    if (!awaitingFirstAnswer(s)) return;
    const sdp = s.pc.localDescription?.sdp ?? s.offerSdp;
    s.restartGen += 1; // numbered before sending: an answer to an older copy never matches
    transmitFirstOffer(s, sdp, s.restartGen, failures);
  });
}

// --- The callee's answer (P3) --------------------------------------------------------------

/**
 * Sends our answer to offer `gen`, preceded by our attestation (the same one every time). A
 * request that got no response is retried (backoff) while this answer is still the current
 * one: not once a newer offer has been applied (it gets its own answer), once connected (the
 * caller evidently has it), or after the call ended or its deadline (negotiation / reconnect)
 * passed. The caller's own re-sent offer also leads here.
 */
function deliverAnswer(s, gen, sdp, failures) {
  if (!isCurrent(s) || s.offerGen !== gen || phase() === P.CONNECTED) return;
  const body = {
    kind: 'answer',
    sdp: s.pc?.localDescription?.type === 'answer' ? s.pc.localDescription.sdp : sdp,
    ...(gen > 0 && { restart: gen }),
  };
  sendAttestation(s)
    .then(() => sendSignal(s, body))
    .catch((err) =>
      onSignalSendError(s, err, failures, (n) =>
        setTimer(s, 'answerRetry', retryDelay(n), () => deliverAnswer(s, gen, sdp, n)),
      ),
    );
}

async function sendOffer(s, { restart = false } = {}) {
  // Numbered before the offer exists, so a late answer to the previous one can never match it.
  const gen = restart ? ++s.restartGen : 0;
  if (restart) s.pc.restartIce?.();
  const offer = await s.pc.createOffer({});
  if (!isCurrent(s)) return;
  await s.pc.setLocalDescription(offer);
  if (!isCurrent(s)) return;
  await sendSignal(s, { kind: 'offer', sdp: offer.sdp, ...(gen > 0 && { restart: gen }) });
}

function onLocalCandidate(s, candidate) {
  if (!candidate || !isCurrent(s)) return; // null = gathering finished
  const init = candidate.toJSON?.() ?? {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
  };
  const text = init.candidate;
  if (!text || text.length > CALL_LIMITS.CANDIDATE_MAX_CHARS || s.sentCandidates.has(text)) return;
  s.sentCandidates.add(text);
  s.outgoingCandidates.push({
    candidate: text,
    sdpMid: init.sdpMid ?? null,
    sdpMLineIndex: init.sdpMLineIndex ?? null,
  });
  if (!s.timers.has('candidates')) {
    setTimer(s, 'candidates', CALL_TIMEOUTS.CANDIDATE_BATCH_MS, () => flushCandidates(s));
  }
}

function flushCandidates(s) {
  while (s.outgoingCandidates.length > 0) {
    const candidates = s.outgoingCandidates.splice(0, CALL_LIMITS.CANDIDATES_PER_REQUEST);
    // A lost candidate batch is not fatal: other candidates (or an ICE restart) still connect.
    sendSignal(s, { kind: 'candidates', candidates }).catch(() => {});
  }
}

async function addRemoteCandidate(s, candidate) {
  try {
    await s.pc.addIceCandidate(media.toIceCandidate(candidate));
  } catch {
    // An unusable candidate is skipped; ICE uses the others.
  }
}

async function applySignal(s, signal) {
  if (!isCurrent(s)) return;
  if (!s.pc) {
    s.pendingSignals.push(signal); // the callee's peer connection is still being prepared
    return;
  }
  if (signal.kind === 'attest') {
    await acceptAttestation(s, signal);
  } else if (signal.kind === 'offer') {
    // Only a newer offer than the last one applied: a duplicate, or an older restart offer
    // delivered late, would roll the connection back to ICE credentials already replaced.
    const gen = Number.isInteger(signal.restart) ? signal.restart : 0;
    if (gen <= s.offerGen) return;
    // Its fingerprints must be the ones the caller attested (held until that is known).
    if (!admitDescription(s, signal)) return;
    s.offerGen = gen;
    await s.pc.setRemoteDescription(media.toSessionDescription({ type: 'offer', sdp: signal.sdp }));
    s.remoteDescriptionSet = true;
    s.generationCandidates = 0; // a new remote description starts a new ICE generation
    for (const candidate of s.pendingCandidates.splice(0)) await addRemoteCandidate(s, candidate);
    const answer = await s.pc.createAnswer();
    if (!isCurrent(s)) return;
    await s.pc.setLocalDescription(answer);
    if (!isCurrent(s)) return;
    // Echo which offer this answers (the caller may have re-sent its offer meanwhile). Not
    // awaited here: a retried answer must not hold up the signals queued behind it.
    deliverAnswer(s, gen, answer.sdp, 0);
  } else if (signal.kind === 'answer') {
    if (s.pc.signalingState !== 'have-local-offer') return; // duplicate or stale answer
    const restart = Number.isInteger(signal.restart) ? signal.restart : 0;
    if (restart !== s.restartGen) return; // answers an older (re-sent) offer, not ours
    // Its fingerprints must be the ones the callee attested (held until that is known).
    if (!admitDescription(s, signal)) return;
    clearTimer(s, 'restartAnswer');
    clearTimer(s, 'offerResend');
    await s.pc.setRemoteDescription(
      media.toSessionDescription({ type: 'answer', sdp: signal.sdp }),
    );
    s.remoteDescriptionSet = true;
    s.generationCandidates = 0; // a new remote description starts a new ICE generation
    for (const candidate of s.pendingCandidates.splice(0)) await addRemoteCandidate(s, candidate);
  } else if (signal.kind === 'candidates' && Array.isArray(signal.candidates)) {
    for (const candidate of signal.candidates) {
      const text = candidate?.candidate;
      if (typeof text !== 'string' || text.length > CALL_LIMITS.CANDIDATE_MAX_CHARS) continue;
      if (s.receivedCandidates.has(text)) continue; // duplicate (resent or replayed)
      // A real exchange needs a handful; a flood would only make this phone probe addresses
      // chosen by someone else. Bounded per ICE generation and per call.
      if (
        s.generationCandidates >= CALL_LIMITS.CANDIDATES_PER_GENERATION ||
        s.receivedCandidates.size >= CALL_LIMITS.CANDIDATES_PER_CALL
      ) {
        break;
      }
      s.receivedCandidates.add(text);
      s.generationCandidates += 1;
      if (s.remoteDescriptionSet) await addRemoteCandidate(s, candidate);
      else s.pendingCandidates.push(candidate);
    }
  } else if (signal.kind === 'media') {
    if (typeof signal.video !== 'boolean') return;
    s.remoteVideoFlag = signal.video;
    useCallStore.setState({ remoteVideo: signal.video && s.remoteStream !== null });
  }
}

/** Signaling is applied strictly in arrival order (WebRTC calls are asynchronous). */
function queueSignal(s, signal) {
  s.signalChain = s.signalChain
    .then(() => applySignal(s, signal))
    .catch(() => fail(s, END_REASON.FAILED));
}

function restartIce(s) {
  if (s.iceRestarted || s.direction !== 'outgoing') return;
  s.iceRestarted = true;
  s.remoteDescriptionSet = false;
  sendOffer(s, { restart: true })
    .then(() => {
      // Sent, but its answer may be lost on the way back: offer again until answered. Still
      // unanswered = our offer is still pending (the answer may also arrive before this runs).
      const unanswered = () =>
        isCurrent(s) && phase() === P.RECONNECTING && s.pc?.signalingState === 'have-local-offer';
      if (!unanswered()) return;
      setTimer(s, 'restartAnswer', CALL_TIMEOUTS.RESTART_ANSWER_MS, () => {
        if (!unanswered()) return;
        s.iceRestarted = false;
        restartIce(s);
      });
    })
    .catch((err) => {
      if (!isCurrent(s)) return;
      // The offer did not get out, typically the first request on a network that is still
      // coming up: try again while the reconnect deadline allows. Anything else is final.
      if (err instanceof NetworkError && s.timers.has('reconnect')) {
        s.iceRestarted = false;
        setTimer(s, 'iceRestart', CALL_TIMEOUTS.ICE_RESTART_AFTER_MS, () => restartIce(s));
      } else {
        fail(s, END_REASON.CONNECTION_LOST);
      }
    });
}

/**
 * WebRTC reports connection *changes* only: a path that survived a network change (or an ICE
 * restart that switched paths seamlessly) never says "connected" again. Read its live state.
 */
function recoverIfConnected(s) {
  if (phase() === P.RECONNECTING && s.pc?.connectionState === 'connected') {
    onConnectionState(s, 'connected');
  }
}

/** The call ends as "Connection lost" unless it recovers in time; never while it is up. */
function armReconnectDeadline(s) {
  setTimer(s, 'reconnect', CALL_TIMEOUTS.RECONNECT_MS, () => {
    recoverIfConnected(s);
    if (phase() === P.RECONNECTING) fail(s, END_REASON.CONNECTION_LOST);
  });
}

/**
 * Which path (direct / through NAT / TURN) the connection uses now, from the selected
 * candidate pair only (never from the configured ICE servers); "undetermined" when the stats
 * name none. Read when the call connects and, in development builds (the only place it is
 * shown), again every ROUTE_REFRESH_MS while connected: an ICE restart can move the call to
 * another pair without any state change. Ignored once the call is over.
 */
function refreshRoute(s) {
  const { pc } = s;
  media.getConnectionRoute(pc).then((info) => {
    if (!isCurrent(s) || s.pc !== pc) return;
    useCallStore.setState({ route: info?.route ?? ICE_ROUTE.UNDETERMINED });
    if (__DEV__ && phase() === P.CONNECTED) {
      setTimer(s, 'route', CALL_TIMEOUTS.ROUTE_REFRESH_MS, () => {
        if (phase() === P.CONNECTED) refreshRoute(s);
      });
    }
  });
}

function onConnectionState(s, state) {
  if (!isCurrent(s)) return;
  if (state === 'connected') {
    clearTimer(s, 'negotiation');
    clearTimer(s, 'reconnect');
    clearTimer(s, 'iceRestart');
    clearTimer(s, 'recheck');
    clearTimer(s, 'restartAnswer');
    clearTimer(s, 'offerResend');
    clearTimer(s, 'answerRetry');
    s.iceRestarted = false; // recovered: the next drop may restart ICE again
    const first = phase() === P.CONNECTING;
    if (first) s.connectedAt = Date.now();
    if (first) {
      markInProgress(s); // from here on, a killed app still finds this call at its next start
      keepMarkerAlive(s);
    }
    if (move(I.CONNECTED, first ? { connectedAt: s.connectedAt } : {})) {
      media.audio.setSpeaker(useCallStore.getState().speaker);
      refreshRoute(s); // also after a reconnect: the path may have changed (e.g. Wi-Fi → mobile)
      if (first && s.kind === CALL_KIND.VIDEO && !(localVideoTrack(s)?.enabled ?? false)) {
        sendMediaState(s); // we joined with the camera off or unavailable: say so
      }
    }
  } else if (state === 'disconnected') {
    if (move(I.DISCONNECTED)) {
      armReconnectDeadline(s);
      setTimer(s, 'iceRestart', CALL_TIMEOUTS.ICE_RESTART_AFTER_MS, () => restartIce(s));
    }
  } else if (state === 'failed') {
    const wasConnected = phase() === P.CONNECTED || phase() === P.RECONNECTING;
    if (wasConnected && s.direction === 'outgoing' && !s.iceRestarted) {
      move(I.DISCONNECTED);
      if (!s.timers.has('reconnect')) armReconnectDeadline(s);
      restartIce(s);
    } else {
      fail(s, wasConnected ? END_REASON.CONNECTION_LOST : END_REASON.FAILED);
    }
  }
}

function startNegotiationTimer(s) {
  setTimer(s, 'negotiation', CALL_TIMEOUTS.NEGOTIATION_MS, () =>
    // A description still waiting for its attestation: the other phone's keys never verified.
    fail(
      s,
      s.heldDescriptions.length > 0 && !s.peerFingerprints
        ? END_REASON.SECURITY_UNVERIFIED
        : END_REASON.FAILED,
    ),
  );
}

/** Caller: the callee answered. Build the connection and send the offer. */
function onRemoteAccepted(s) {
  if (!move(I.REMOTE_ACCEPTED)) return;
  clearTimer(s, 'ring');
  try {
    openPeerConnection(s);
  } catch {
    fail(s, END_REASON.FAILED);
    return;
  }
  media.audio.start(s.kind);
  startNegotiationTimer(s);
  sendFirstOffer(s);
}

/** The other side's phone could not take or keep the call (not a choice they made). */
const COULD_NOT = new Set(['failed', 'connection_lost']);

/**
 * Why the call ended, from what the server says the other side did and where this phone was:
 * a decline, "couldn't take the call", no answer, a cancel and a failed connection all read
 * differently. (Older servers reported "couldn't take the call" as rejected with reason failed.)
 */
export function remoteEndReason(status, reason, current) {
  switch (status) {
    case CALL_STATUS.CANCELLED:
      return END_REASON.MISSED; // the caller gave up before we answered: missed for us
    case CALL_STATUS.MISSED:
      return END_REASON.MISSED;
    case CALL_STATUS.REJECTED:
      return COULD_NOT.has(reason) ? END_REASON.UNAVAILABLE : END_REASON.REJECTED;
    case CALL_STATUS.FAILED:
      if (current === P.OUTGOING) return END_REASON.UNAVAILABLE; // still ringing for us
      if (current === P.CONNECTED || current === P.RECONNECTING) return END_REASON.CONNECTION_LOST;
      return END_REASON.FAILED; // answered, but never connected
    default:
      return END_REASON.REMOTE_HANGUP;
  }
}

function onRemoteEnded(s, { status, reason }) {
  finish(s, remoteEndReason(status, reason, phase()));
}

function onInvite({ callId, callerUserId, kind, createdAt, ringExpiresAt }) {
  if (session || finishedCalls.has(callId) || typeof callerUserId !== 'string') return;
  if (phase() === P.ENDED) resetNow();
  const callKind = kind === CALL_KIND.VIDEO ? CALL_KIND.VIDEO : CALL_KIND.VOICE;
  const s = newSession({
    direction: 'incoming',
    peerUserId: callerUserId,
    callId,
    kind: callKind,
  });
  session = s;
  callEpoch += 1;
  if (
    !move(I.RING, {
      ...freshCallState(callKind),
      callId,
      peerUserId: callerUserId,
      direction: 'incoming',
    })
  ) {
    session = null;
    return;
  }
  const ringMs = armRingTimeout(s, { createdAt, ringExpiresAt });
  armRingCheck(s);
  media.audio.startRingtone(ringMs); // rings (and vibrates) only as long as the call can ring
  rememberPeer(s);
  // A new security code for the caller must be reviewed before this call can be answered.
  identityPending(callerUserId).then((pending) => {
    if (pending && isCurrent(s)) useCallStore.setState({ identityChanged: true });
  });
}

/** Whether a contact's new security code awaits the user's review (see signalService). */
const identityPending = (peerUserId) =>
  getPendingIdentityChange(peerUserId).then(Boolean, () => false);

function dispatch(s, payload) {
  if (payload.callId !== s.callId) return; // another (older) call: ignore
  if (payload.type === CALL_EVENT.ACCEPTED) {
    if (phase() === P.OUTGOING) onRemoteAccepted(s);
  } else if (payload.type === CALL_EVENT.SIGNAL) {
    queueSignal(s, payload);
  } else if (payload.type === CALL_EVENT.ENDED) {
    onRemoteEnded(s, payload);
  }
}

// --- Public API ----------------------------------------------------------------------------

/** A realtime `call` event from Pusher. Validated, then applied only if it fits. */
export function handleCallEvent(payload) {
  if (!payload || typeof payload.callId !== 'string' || typeof payload.type !== 'string') return;
  if (payload.type === CALL_EVENT.INVITE) {
    onInvite(payload);
    return;
  }
  const s = session;
  if (!s || s.closed) return;
  if (s.callId === null) {
    s.early.push(payload); // our POST /calls has not returned yet
    return;
  }
  dispatch(s, payload);
}

/** Why acquiring the microphone/camera failed, as an end reason. */
function mediaFailureReason(err) {
  if (err?.code === 'MIC_PERMISSION_DENIED') return END_REASON.PERMISSION_DENIED;
  if (err?.code === 'CAMERA_PERMISSION_DENIED') return END_REASON.CAMERA_DENIED;
  if (err?.code === 'MEDIA_TIMEOUT') return END_REASON.MEDIA_UNAVAILABLE;
  return END_REASON.FAILED;
}

/** Ends on a media failure; a refused permission also says whether only Settings can fix it. */
function finishOnMediaFailure(s, err) {
  finish(s, mediaFailureReason(err), { permissionBlocked: err?.blocked === true });
}

/** The local stream is ours: keep it, show our camera, keep the mic alive in the background. */
function adoptLocalStream(s, stream) {
  s.stream = stream;
  const video = localVideoTrack(s);
  useCallStore.setState({
    localStreamUrl: video ? (stream.toURL?.() ?? null) : null,
    cameraUnavailable: s.kind === CALL_KIND.VIDEO && !video,
  });
  media.keepAlive.start(); // the user is in the app now: keep the mic if they leave it
}

/**
 * Starts a call to `peerUserId` (voice, or video with `{ video: true }`). Returns false if a
 * call is already in progress.
 */
export async function startCall(peerUserId, { video = false } = {}) {
  if (isActivePhase(phase())) return false;
  resetNow();
  const kind = video ? CALL_KIND.VIDEO : CALL_KIND.VOICE;
  const s = newSession({ direction: 'outgoing', peerUserId, kind });
  session = s;
  callEpoch += 1;
  move(I.DIAL, { ...freshCallState(kind), peerUserId, direction: 'outgoing' });
  rememberPeer(s);

  // A contact whose new security code is undecided cannot be called until it is reviewed: the
  // call could only be verified with a key this phone does not trust yet. Nothing is sent.
  if (await identityPending(peerUserId)) {
    finish(s, END_REASON.IDENTITY_CHANGED);
    return true;
  }
  if (!isCurrent(s)) return true;

  // Microphone (and camera) first: the permission prompts appear only because the user pressed
  // "call". A caller whose camera is refused is told; they can place a voice call instead.
  try {
    const stream = await media.getMedia({ video, facing: s.facing });
    if (!isCurrent(s)) {
      stopStream(stream); // cancelled during the prompt
      return true;
    }
    adoptLocalStream(s, stream);
  } catch (err) {
    finishOnMediaFailure(s, err);
    return true;
  }

  let result;
  try {
    result = await apiRequest('POST', ENDPOINTS.CALLS.ROOT, {
      body: { calleeUserId: peerUserId, kind },
    });
  } catch (err) {
    finish(s, startReason(err));
    return true;
  }
  s.callId = result.call.callId;
  callEpoch += 1;
  s.iceServers = result.iceServers;
  s.iceTransportPolicy = result.iceTransportPolicy ?? null;
  if (!isCurrent(s)) {
    notifyEnd(s.callId, 'hangup'); // hung up while the request was in flight
    finishedCalls.add(s.callId);
    return true;
  }
  useCallStore.setState({ callId: s.callId });
  armRingTimeout(s, result.call);
  armRingCheck(s);
  for (const payload of s.early.splice(0)) dispatch(s, payload);
  return true;
}

/**
 * Answers the ringing call. Blocked (the call keeps ringing) while the caller's new security
 * code awaits review: once the user accepts it in the chat, answering works again.
 */
export async function answerCall() {
  const s = session;
  if (!s || s.direction !== 'incoming' || phase() !== P.INCOMING) return;
  if (await identityPending(s.peerUserId)) {
    if (isCurrent(s)) useCallStore.setState({ identityChanged: true });
    return;
  }
  if (!isCurrent(s) || !move(I.ANSWER, { identityChanged: false })) return;
  clearTimer(s, 'ring');
  media.audio.stopRingtone();

  try {
    let stream;
    try {
      stream = await media.getMedia({ video: s.kind === CALL_KIND.VIDEO, facing: s.facing });
    } catch (err) {
      // The person called us on video but refused the camera: still answer, audio only. They
      // chose to answer; the caller sees "camera off" and can still talk.
      if (err?.code !== 'CAMERA_PERMISSION_DENIED') throw err;
      stream = await media.getMedia({ video: false });
    }
    if (!isCurrent(s)) {
      stopStream(stream);
      return;
    }
    adoptLocalStream(s, stream);
  } catch (err) {
    notifyEnd(s.callId, 'failed');
    finishOnMediaFailure(s, err);
    return;
  }

  let result;
  try {
    result = await apiRequest('POST', ENDPOINTS.CALLS.accept(s.callId));
  } catch (err) {
    if (err instanceof ApiError && err.code === ERROR_CODE.CALL_ENDED) {
      finish(s, END_REASON.MISSED); // the caller gave up just before
    } else {
      fail(s, END_REASON.FAILED);
    }
    return;
  }
  if (!isCurrent(s)) return;
  s.iceServers = result.iceServers;
  s.iceTransportPolicy = result.iceTransportPolicy ?? null;
  try {
    openPeerConnection(s);
  } catch {
    fail(s, END_REASON.FAILED);
    return;
  }
  media.audio.start(s.kind);
  move(I.MEDIA_READY);
  startNegotiationTimer(s);
  for (const signal of s.pendingSignals.splice(0)) queueSignal(s, signal);
}

/** Declines the ringing call. */
export function declineCall() {
  const s = session;
  if (!s || s.direction !== 'incoming' || phase() !== P.INCOMING) return;
  apiRequest('POST', ENDPOINTS.CALLS.reject(s.callId)).catch(() => {});
  finish(s, END_REASON.DECLINED);
}

/** Hangs up (or cancels an unanswered outgoing call). Safe to call any number of times. */
export function hangUp() {
  const s = session;
  if (!s) return;
  if (s.direction === 'incoming' && phase() === P.INCOMING) {
    declineCall();
    return;
  }
  notifyEnd(s.callId, 'hangup');
  finish(s, END_REASON.HANGUP);
}

export function toggleMute() {
  const muted = !useCallStore.getState().muted;
  for (const track of session?.stream?.getAudioTracks?.() ?? []) track.enabled = !muted;
  useCallStore.setState({ muted });
}

export function toggleSpeaker() {
  const speaker = !useCallStore.getState().speaker;
  media.audio.setSpeaker(speaker);
  useCallStore.setState({ speaker });
}

/** Camera on/off (video calls). Off stops sending frames; the camera track stays for later. */
export function toggleCamera() {
  const s = session;
  if (!s || !isCurrent(s) || s.kind !== CALL_KIND.VIDEO) return;
  const { cameraOff: wasOff, cameraUnavailable } = useCallStore.getState();
  if (cameraUnavailable) return;
  const track = localVideoTrack(s);
  if (!track && (wasOff === false || s.videoPausedInBackground)) return; // nothing to switch
  const cameraOff = !wasOff;
  useCallStore.setState({ cameraOff });
  if (track) {
    track.enabled = !cameraOff;
    sendMediaState(s);
    return;
  }
  // The camera was released while the app was away and the user kept it off: get it back now.
  cameraTask(s, async () => {
    await acquireCamera(s);
    sendMediaState(s);
  });
}

/** Front ⇄ back camera (video calls); no renegotiation. */
export function switchCamera() {
  const s = session;
  const track = s && localVideoTrack(s);
  if (!track || !isCurrent(s)) return;
  const facing = media.switchCamera(track, s.facing);
  if (!facing) return;
  s.facing = facing;
  useCallStore.setState({ facing });
}

/**
 * App left or returned to the screen. Android does not let a backgrounded app capture the
 * camera (it closes it), so our camera is released when the app leaves the screen (the other
 * side is told) and reopened on return, unless the user had switched it off. Audio carries on
 * through the foreground service. Signals sent from the background may reach the other phone
 * late (background networking is throttled); the frames themselves stop at once.
 *
 * Nothing happens until the call holds its camera and microphone: the permission dialog of a
 * first call pauses the app too, and reopening the camera when it closed raced the capture the
 * call itself was starting.
 */
export function handleCallAppState(state) {
  const s = session;
  if (!s || !isCurrent(s) || s.kind !== CALL_KIND.VIDEO || !s.stream) return;
  if (state === 'background' || state === 'inactive') {
    if (s.videoPausedInBackground) return;
    s.videoPausedInBackground = true;
    const wasSending = localVideoTrack(s)?.enabled === true;
    cameraTask(s, async () => {
      await releaseCamera(s);
      if (wasSending) sendMediaState(s);
    });
  } else if (state === 'active' && s.videoPausedInBackground) {
    s.videoPausedInBackground = false;
    if (useCallStore.getState().cameraOff) return; // stays released until "Camera on"
    // Camera gone meanwhile (e.g. permission revoked): audio carries on.
    cameraTask(s, async () => {
      if (s.videoPausedInBackground) return; // left again before its turn
      await acquireCamera(s);
      sendMediaState(s);
    });
  }
}

AppState.addEventListener?.('change', handleCallAppState);

export const isCallActive = () => isActivePhase(phase());

/**
 * The phone switched networks (Wi-Fi ⇄ mobile data) or came back online during a call. The
 * media path almost certainly broke, and WebRTC can take 10 s or more to notice on its own, so
 * the caller restarts ICE now (the callee's side is recovered by the caller's restart, as in
 * onConnectionState). The call shows "Reconnecting…" meanwhile; if the new path does not
 * connect within RECONNECT_MS it ends as "Connection lost". If the old path survived the change
 * (WebRTC still reports the connection up after NETWORK_RECHECK_MS), the call simply carries on.
 * Nothing is renegotiated beyond ICE: same call, same authorization, same tracks.
 */
export function handleCallNetworkChange() {
  const s = session;
  if (!s || !isCurrent(s) || !s.pc) return;
  const current = phase();
  if (current === P.CONNECTED) {
    if (!move(I.DISCONNECTED)) return;
    armReconnectDeadline(s);
  } else if (current !== P.RECONNECTING) {
    return;
  }
  setTimer(s, 'recheck', CALL_TIMEOUTS.NETWORK_RECHECK_MS, () => recoverIfConnected(s));
  if (s.direction !== 'outgoing') return;
  clearTimer(s, 'iceRestart');
  s.iceRestarted = false; // a new network is a new attempt
  restartIce(s);
}

/**
 * Brings this phone in line with the server's view of its current call. Runs when Pusher
 * (re)connects, when the app comes to the foreground and when a call notification is tapped,
 * so a lost event, a restart or a crash never leaves a call stuck. Polls only while a call
 * rings (armRingCheck); never otherwise.
 */
let reconciling = null;
export function reconcileCall() {
  reconciling ??= runReconcile().finally(() => {
    reconciling = null;
  });
  return reconciling;
}

async function runReconcile() {
  const epoch = callEpoch;
  let call;
  try {
    ({ call } = await apiRequest('GET', ENDPOINTS.CALLS.CURRENT));
  } catch {
    return; // offline: try again on the next reconnect
  }
  // This phone's call changed while the request was in flight (a call started ringing or was
  // dialled, got its id, ended, or the user signed out): the answer describes the state before
  // that, e.g. "no call" for a call the server had not created yet. Acting on it could end the
  // new call, send an `end` for a call already over or ring after sign-out, so it is dropped.
  // The next read (a ringing call's own check, a reconnect, the foreground) sees the change.
  if (epoch !== callEpoch) return;
  if (!call) {
    // Our call ended while we were not listening (Pusher down, app in background).
    const s = session;
    if (s?.callId && isCurrent(s)) {
      finish(s, phase() === P.INCOMING ? END_REASON.MISSED : END_REASON.REMOTE_HANGUP);
    }
    return;
  }
  if (finishedCalls.has(call.callId)) {
    notifyEnd(call.callId, 'hangup'); // we ended it locally but the server never heard
    return;
  }
  const ringingHere = session;
  let closedStale = false;
  if (ringingHere?.callId && ringingHere.callId !== call.callId && isRinging()) {
    // One call per person: the server's current call is another one, so the call ringing here
    // is over (its "ended" event was lost, e.g. the caller gave up and called again). Close it;
    // a newer call ringing for us rings below, from the server's own record.
    finish(ringingHere, phase() === P.INCOMING ? END_REASON.MISSED : END_REASON.REMOTE_HANGUP);
    closedStale = true;
  }
  const s = session;
  if (!s) {
    if (call.role === 'callee' && call.status === CALL_STATUS.RINGING) {
      onInvite({
        callId: call.callId,
        callerUserId: call.peerUserId,
        kind: call.kind,
        createdAt: call.createdAt,
        ringExpiresAt: call.ringExpiresAt,
      });
    } else if (!closedStale) {
      // A call this phone was in before the app was closed or crashed: its WebRTC state is
      // gone and cannot be resumed, so end it for both sides.
      notifyEnd(call.callId, call.status === CALL_STATUS.RINGING ? 'hangup' : 'failed');
      finishedCalls.add(call.callId);
    }
    return;
  }
  if (s.callId === call.callId && phase() === P.OUTGOING && call.status === CALL_STATUS.ACCEPTED) {
    onRemoteAccepted(s); // the "accepted" event was lost
  }
}

/** A tapped "Incoming voice call" notification: show the call if it still rings. */
export async function openCallFromNotification(callId) {
  await reconcileCall();
  const state = useCallStore.getState();
  return state.callId === callId && isActivePhase(state.phase);
}

/** Sign-out / account deletion: release everything locally (the server ends the call). */
export function endCallForSignOut() {
  const s = session;
  if (s) finish(s, END_REASON.SIGNED_OUT);
  callEpoch += 1; // also without a call: a read in flight belongs to the signed-out account
  resetNow();
}
