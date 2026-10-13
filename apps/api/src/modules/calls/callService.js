import { randomUUID } from 'node:crypto';

import {
  CALL_EVENT,
  CALL_KIND,
  CALL_LIMITS,
  CALL_STATUS,
  CALL_TERMINAL_STATUSES,
  ERROR_CODE,
  LIMITS,
  REALTIME_EVENT,
} from '@secure-chat/shared/constants';
import mongoose from 'mongoose';

import { HttpError } from '../../middleware/errors.js';
import { Device } from '../../models/Device.js';
import { deviceChannel } from '../../services/realtime/index.js';
import { createCallStore } from './callStore.js';
import { buildIceServers } from './iceServers.js';

/** A finished call is kept briefly so late or duplicate requests get CALL_ENDED, not 404. */
const ENDED_RETENTION_MS = 60_000;
/** Extra time before the server's ring timer fires (the clients' own timers fire first). */
const RING_GRACE_MS = 1_000;
/** Reasons a phone may give when ending a call. */
export const END_REASONS = Object.freeze(['hangup', 'timeout', 'failed', 'connection_lost']);
/** How long an uncollected missed-call note waits for the callee's phone. */
export const MISSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Ended without the callee answering or declining: they may never have seen it ring. */
const UNANSWERED = [CALL_STATUS.MISSED, CALL_STATUS.CANCELLED];

const isTerminal = (status) => CALL_TERMINAL_STATUSES.includes(status);

/**
 * 1:1 voice call signaling. The server decides who may do what and relays signaling to the
 * other participant's own device channel; it never sees or carries audio. A call is bound to
 * the exact device that placed it and the exact device that was rung: only those two sessions
 * can act on it, and anyone else gets 404 (no call-id enumeration).
 *
 * @param {{
 *   redis: import('ioredis').Redis,
 *   realtime: { publish(channel: string, event: string, payload: object): Promise<void> },
 *   pushNotifier: { notifyIncomingCall(args: object): void } | null,
 *   config: { ringTimeoutSeconds: number, maxDurationSeconds: number, stunUrls: string[],
 *             turn: object | null },
 *   logger: import('pino').Logger,
 * }} deps
 */
export function createCallService({ redis, realtime, pushNotifier, config, logger }) {
  const store = createCallStore(redis);
  const ringMs = config.ringTimeoutSeconds * 1000;
  const activeTtlMs = config.maxDurationSeconds * 1000;
  const pending = new Set();

  const notFound = () => new HttpError(404, ERROR_CODE.CALL_NOT_FOUND, 'Call not found');
  const ended = () => new HttpError(409, ERROR_CODE.CALL_ENDED, 'This call has already ended');
  const invalidState = (message) => new HttpError(409, ERROR_CODE.CALL_INVALID_STATE, message);

  function roleOf(call, auth) {
    if (call.callerUserId === auth.userId && call.callerDeviceId === auth.deviceId) return 'caller';
    if (call.calleeUserId === auth.userId && call.calleeDeviceId === auth.deviceId) return 'callee';
    return null;
  }

  const otherDevice = (call, role) =>
    role === 'caller' ? call.calleeDeviceId : call.callerDeviceId;

  /** What a participant may see: no device ids, no ICE/SDP, nothing about anyone else. */
  function view(call, role) {
    return {
      callId: call.callId,
      role,
      peerUserId: role === 'caller' ? call.calleeUserId : call.callerUserId,
      kind: call.kind || CALL_KIND.VOICE,
      status: call.status,
      reason: call.reason,
      createdAt: call.createdAt,
      ringExpiresAt: call.ringExpiresAt,
      answeredAt: call.answeredAt,
      endedAt: call.endedAt,
    };
  }

  /**
   * WebRTC configuration for one participant of one call: ICE servers (TURN credentials minted
   * for this call) and whether media may go direct or must be relayed. Only ever returned in the
   * HTTPS response to that participant; never published, pushed, stored or logged.
   */
  const iceFor = (call) => ({
    iceServers: buildIceServers(config, call),
    iceTransportPolicy: config.iceTransportPolicy ?? 'all',
  });

  /** Best effort, like message events: a lost event is recovered by GET /calls/current. */
  async function publish(deviceId, payload) {
    try {
      await realtime.publish(deviceChannel(deviceId), REALTIME_EVENT.CALL, payload);
    } catch (err) {
      logger.warn({ err, callId: payload.callId, type: payload.type }, 'Call event publish failed');
    }
  }

  /**
   * Leaves the callee a note of a call they did not answer, so it reaches their phone's call
   * history even if the app was closed while it rang. Only who called and when; best effort.
   */
  async function noteMissed(call, endedAt) {
    try {
      const stored = await store.addMissed(
        call.calleeUserId,
        {
          callId: call.callId,
          callerUserId: call.callerUserId,
          kind: call.kind || CALL_KIND.VOICE,
          createdAt: call.createdAt,
          endedAt,
        },
        { ttlMs: MISSED_RETENTION_MS, max: CALL_LIMITS.MISSED_MAX },
      );
      if (!stored) logger.warn({ callId: call.callId }, 'Missed-call notes full; note dropped');
    } catch (err) {
      logger.warn({ err, callId: call.callId }, 'Could not store a missed-call note');
    }
  }

  /** Moves a call to a terminal status and tells the given devices; false if it lost a race. */
  async function finish(call, { from, status, reason, notify }) {
    const endedAt = new Date().toISOString();
    const result = await store.transition(call, {
      from,
      to: status,
      ttlMs: ENDED_RETENTION_MS,
      terminal: true,
      fields: { reason, endedAt },
    });
    if (!result.ok) return false;
    if (UNANSWERED.includes(status)) await noteMissed(call, endedAt);
    await Promise.all(
      notify.map((deviceId) =>
        publish(deviceId, { type: CALL_EVENT.ENDED, callId: call.callId, status, reason }),
      ),
    );
    return true;
  }

  const expireRinging = (call) =>
    finish(call, {
      from: [CALL_STATUS.RINGING],
      status: CALL_STATUS.MISSED,
      reason: 'no_answer',
      notify: [call.callerDeviceId, call.calleeDeviceId],
    });

  /** The call, with an overdue ring expired on read (covers a lost timer or another instance). */
  async function fresh(callId) {
    const call = await store.get(callId);
    if (call?.status === CALL_STATUS.RINGING && Date.now() > Date.parse(call.ringExpiresAt)) {
      await expireRinging(call);
      return store.get(callId);
    }
    return call;
  }

  async function loadForParticipant(auth, callId) {
    const call = await fresh(callId);
    const role = call && roleOf(call, auth);
    if (!role) throw notFound();
    return { call, role };
  }

  function scheduleRingTimeout(call) {
    const run = new Promise((resolve) => {
      const timer = setTimeout(resolve, ringMs + RING_GRACE_MS);
      timer.unref?.();
    })
      .then(async () => {
        const current = await store.get(call.callId);
        if (current?.status === CALL_STATUS.RINGING) await expireRinging(current);
      })
      .catch((err) => logger.warn({ err, callId: call.callId }, 'Ring timeout handling failed'));
    pending.add(run);
    run.finally(() => pending.delete(run));
  }

  /** Caller starts a call: rings the callee's active device (Pusher + push notification). */
  async function createCall(auth, { calleeUserId, kind = CALL_KIND.VOICE }) {
    if (calleeUserId === auth.userId) {
      throw new HttpError(400, ERROR_CODE.VALIDATION_ERROR, 'You cannot call yourself');
    }
    const device = await Device.findOne({
      userId: calleeUserId,
      revokedAt: null,
      signal: mongoose.trusted({ $ne: null }),
    })
      .sort({ lastActiveAt: -1 })
      .select('deviceId')
      .lean();
    if (!device) {
      throw new HttpError(404, ERROR_CODE.CALLEE_UNAVAILABLE, 'This person cannot be called');
    }

    const now = Date.now();
    const call = {
      callId: randomUUID(),
      callerUserId: auth.userId,
      callerDeviceId: auth.deviceId,
      calleeUserId,
      calleeDeviceId: device.deviceId,
      status: CALL_STATUS.RINGING,
      reason: '',
      createdAt: new Date(now).toISOString(),
      ringExpiresAt: new Date(now + ringMs).toISOString(),
      answeredAt: '',
      endedAt: '',
      kind,
    };
    const created = await store.create(call, ringMs + RING_GRACE_MS + ENDED_RETENTION_MS);
    if (created === 'CALLER_BUSY') {
      throw new HttpError(409, ERROR_CODE.ALREADY_IN_CALL, 'You are already in a call');
    }
    if (created === 'CALLEE_BUSY') {
      throw new HttpError(409, ERROR_CODE.CALLEE_BUSY, 'This person is on another call');
    }

    await publish(call.calleeDeviceId, {
      type: CALL_EVENT.INVITE,
      callId: call.callId,
      callerUserId: call.callerUserId,
      kind,
      createdAt: call.createdAt,
      ringExpiresAt: call.ringExpiresAt,
    });
    pushNotifier?.notifyIncomingCall({
      userId: calleeUserId,
      deviceId: call.calleeDeviceId,
      callId: call.callId,
      kind,
      ttlSeconds: config.ringTimeoutSeconds,
    });
    scheduleRingTimeout(call);
    return { call: view(call, 'caller'), ...iceFor(call) };
  }

  /** Callee answers. Idempotent for the same device (a retried request returns the same). */
  async function acceptCall(auth, callId) {
    const { call, role } = await loadForParticipant(auth, callId);
    if (role !== 'callee') {
      throw new HttpError(403, ERROR_CODE.FORBIDDEN, 'Only the person being called can answer');
    }
    if (call.status === CALL_STATUS.RINGING) {
      const answeredAt = new Date().toISOString();
      const result = await store.transition(call, {
        from: [CALL_STATUS.RINGING],
        to: CALL_STATUS.ACCEPTED,
        ttlMs: activeTtlMs,
        terminal: false,
        fields: { answeredAt },
      });
      if (result.ok) {
        await publish(call.callerDeviceId, { type: CALL_EVENT.ACCEPTED, callId });
        call.status = CALL_STATUS.ACCEPTED;
        call.answeredAt = answeredAt;
      } else if (result.current !== CALL_STATUS.ACCEPTED) {
        throw ended(); // cancelled or timed out at the same moment
      }
    } else if (call.status !== CALL_STATUS.ACCEPTED) {
      throw ended();
    }
    const latest = (await store.get(callId)) ?? call;
    return { call: view(latest, 'callee'), ...iceFor(call) };
  }

  /** Callee declines while it rings. Idempotent. */
  async function rejectCall(auth, callId) {
    const { call, role } = await loadForParticipant(auth, callId);
    if (role !== 'callee') {
      throw new HttpError(403, ERROR_CODE.FORBIDDEN, 'Only the person being called can decline');
    }
    if (call.status === CALL_STATUS.REJECTED) return;
    if (call.status === CALL_STATUS.ACCEPTED) throw invalidState('The call was already answered');
    if (isTerminal(call.status)) throw ended();
    const done = await finish(call, {
      from: [CALL_STATUS.RINGING],
      status: CALL_STATUS.REJECTED,
      reason: 'rejected',
      notify: [call.callerDeviceId],
    });
    if (!done) {
      const current = await store.get(callId);
      if (current?.status !== CALL_STATUS.REJECTED) throw ended();
    }
  }

  /**
   * Either participant hangs up, cancels or reports a failure. Idempotent: ending an ended call
   * is a no-op (both phones often end at the same moment).
   */
  async function endCall(auth, callId, reason) {
    let { call } = await loadForParticipant(auth, callId);
    const role = roleOf(call, auth);
    // Two attempts: if the call moved on meanwhile (e.g. cancel raced the callee's accept), end
    // it from its new state so nobody is left in a call the other side has abandoned.
    for (let attempt = 0; attempt < 2 && call && !isTerminal(call.status); attempt += 1) {
      let status;
      if (call.status === CALL_STATUS.RINGING) {
        if (role === 'caller') {
          status = reason === 'timeout' ? CALL_STATUS.MISSED : CALL_STATUS.CANCELLED;
        } else if (reason === 'failed' || reason === 'connection_lost') {
          // The callee's phone could not take the call (no microphone, setup failed). That is
          // not a decline: the caller must not be told "declined" (a decline is POST /reject).
          status = CALL_STATUS.FAILED;
        } else {
          status = CALL_STATUS.REJECTED;
        }
      } else {
        status =
          reason === 'failed' || reason === 'connection_lost'
            ? CALL_STATUS.FAILED
            : CALL_STATUS.ENDED;
      }
      const done = await finish(call, {
        from: [call.status],
        status,
        reason: status === CALL_STATUS.MISSED ? 'no_answer' : reason,
        notify: [otherDevice(call, role)],
      });
      if (done) return;
      call = await store.get(callId);
    }
  }

  /**
   * Relays WebRTC negotiation (SDP offer/answer, ICE candidates) to the other participant.
   * Only once the call is answered, only in the right direction, never stored.
   */
  async function relaySignal(auth, callId, signal) {
    const { call, role } = await loadForParticipant(auth, callId);
    if (isTerminal(call.status)) throw ended();
    if (call.status !== CALL_STATUS.ACCEPTED) throw invalidState('The call has not been answered');
    if (signal.kind === 'offer' && role !== 'caller') {
      throw new HttpError(403, ERROR_CODE.FORBIDDEN, 'Only the caller sends offers');
    }
    if (signal.kind === 'answer' && role !== 'callee') {
      throw new HttpError(403, ERROR_CODE.FORBIDDEN, 'Only the callee sends answers');
    }
    let event;
    if (signal.kind === 'attest') {
      await assertRecipientKeys(call, role, signal.recipientRegistrationId);
      // Opaque Signal ciphertext, relayed as is with the sending device (like an envelope's
      // sender), which only routes the other phone's later replies: who sent it is proven by
      // the Signal session alone. Never stored or logged.
      event = {
        type: CALL_EVENT.SIGNAL,
        callId,
        kind: 'attest',
        attestation: signal.attestation,
        senderDeviceId: auth.deviceId,
      };
    } else {
      event = { type: CALL_EVENT.SIGNAL, callId, ...signal };
    }
    // Refused rather than handed to Pusher, which would drop an oversized event silently.
    if (Buffer.byteLength(JSON.stringify(event), 'utf8') > LIMITS.PUSHER_EVENT_MAX_BYTES) {
      throw new HttpError(413, ERROR_CODE.PAYLOAD_TOO_LARGE, 'Signal too large to relay');
    }
    await publish(otherDevice(call, role), event);
  }

  /**
   * Like messages: ciphertext built for keys the other device no longer has (it signed in again
   * or reinstalled) is refused, so the sender rebuilds its session from a fresh key bundle.
   */
  async function assertRecipientKeys(call, role, registrationId) {
    if (registrationId === undefined) return;
    const recipient =
      role === 'caller'
        ? { userId: call.calleeUserId, deviceId: call.calleeDeviceId }
        : { userId: call.callerUserId, deviceId: call.callerDeviceId };
    const device = await Device.findOne({ ...recipient, revokedAt: null })
      .select('signal.registrationId')
      .lean();
    if (device?.signal?.registrationId !== registrationId) {
      throw new HttpError(
        409,
        ERROR_CODE.STALE_RECIPIENT_DEVICE,
        'Recipient device changed; fetch a new key bundle',
      );
    }
  }

  /** This device's ongoing call (recovery after a lost event, restart or notification tap). */
  async function currentCall(auth) {
    const callId = await store.currentCallId(auth.userId);
    if (!callId) return null;
    const call = await fresh(callId);
    if (!call || isTerminal(call.status)) return null;
    const role = roleOf(call, auth);
    return role ? view(call, role) : null;
  }

  /**
   * Ends the user's ongoing call because they signed out, were signed out by a new login or
   * device revocation, or deleted their account. With `deviceId`, only a call on that device
   * is ended. Never throws (sign-out must not fail on it).
   */
  async function endCallsForUser(userId, reason, { deviceId } = {}) {
    try {
      const callId = await store.currentCallId(String(userId));
      let call = callId && (await store.get(callId));
      for (let attempt = 0; attempt < 2 && call && !isTerminal(call.status); attempt += 1) {
        const isCaller = call.callerUserId === String(userId);
        const usersDevice = isCaller ? call.callerDeviceId : call.calleeDeviceId;
        if (deviceId && usersDevice !== deviceId) return;
        let status = CALL_STATUS.ENDED;
        if (call.status === CALL_STATUS.RINGING) {
          status = isCaller ? CALL_STATUS.CANCELLED : CALL_STATUS.REJECTED;
        }
        const done = await finish(call, {
          from: [call.status],
          status,
          reason,
          notify: [call.callerDeviceId, call.calleeDeviceId],
        });
        if (done) return;
        call = await store.get(callId);
      }
    } catch (err) {
      logger.warn({ err }, 'Could not end the call of a signed-out user');
    }
  }

  /** Calls this user did not answer that their phone has not collected yet (oldest first). */
  async function listMissedCalls(auth) {
    return store.listMissed(auth.userId);
  }

  /** The phone saved these in its call history: forget them. Idempotent. */
  async function ackMissedCalls(auth, callIds) {
    await store.removeMissed(auth.userId, callIds);
  }

  /** Account deletion: drop the user's uncollected missed-call notes. Never throws. */
  async function forgetUser(userId) {
    try {
      await store.clearMissed(String(userId));
    } catch (err) {
      logger.warn({ err }, 'Could not clear missed-call notes of a deleted account');
    }
  }

  /** Resolves when scheduled ring timeouts have run (tests, graceful shutdown). */
  async function idle() {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  return {
    createCall,
    acceptCall,
    rejectCall,
    endCall,
    relaySignal,
    currentCall,
    endCallsForUser,
    listMissedCalls,
    ackMissedCalls,
    forgetUser,
    idle,
  };
}
