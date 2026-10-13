import mongoose from 'mongoose';

import { Device } from '../../models/Device.js';
import { MessageEnvelope } from '../../models/MessageEnvelope.js';
import { Session } from '../../models/Session.js';

/**
 * The ONLY content a push notification ever carries. No plaintext (the server has none), no
 * sender identity, no conversation id (ours is derived from both user ids), no keys: the app
 * syncs the encrypted envelope over HTTPS and decrypts it locally.
 */
export function buildPushMessage(token, envelope) {
  return {
    to: token,
    title: 'CipherChat',
    body: 'New message',
    data: { type: 'new_message', messageId: String(envelope.messageId), hasMessage: true },
    channelId: 'messages',
    priority: 'high',
    sound: 'default',
  };
}

/**
 * Sends a push for a new envelope only if the recipient device has NOT acknowledged it within
 * `delayMs`. A device that is open and connected to Pusher acks within a second or two, so it
 * gets no duplicate notification; a backgrounded or closed app (Pusher disconnected) does.
 * Best effort: a failure here never affects the already-stored message.
 *
 * @param {{
 *   pushProvider: { send(message: object): Promise<{ ok: boolean, error?: string }> } | null,
 *   delayMs: number,
 *   logger: import('pino').Logger,
 * }} deps
 */
/**
 * The ONLY content an incoming-call push carries: no caller name or number (the app shows who
 * is calling only after it opens, and hides it for locked chats), no SDP, no keys. Short TTL:
 * a call notification delivered after the call stopped ringing would only mislead.
 */
export function buildCallPushMessage(token, { callId, kind, ttlSeconds }) {
  return {
    to: token,
    title: 'CipherChat',
    body: kind === 'video' ? 'Incoming video call' : 'Incoming voice call',
    data: { type: 'incoming_call', callId },
    channelId: 'calls',
    priority: 'high',
    sound: 'default',
    ttl: ttlSeconds,
  };
}

export function createPushNotifier({ pushProvider, delayMs, logger }) {
  const pending = new Set();

  async function notifyIfUndelivered(envelopeId) {
    const envelope = await MessageEnvelope.findById(envelopeId)
      .select('messageId recipientUserId recipientDeviceId deliveredAt')
      .lean();
    if (!envelope || envelope.deliveredAt) return 'delivered';

    const { recipientUserId: userId, recipientDeviceId: deviceId } = envelope;
    return deliverToDevice(userId, deviceId, (token) => buildPushMessage(token, envelope));
  }

  /** Sends to a signed-in device's push token; drops tokens the push service rejects. */
  async function deliverToDevice(userId, deviceId, buildMessage) {
    const [device, signedIn] = await Promise.all([
      Device.findOne({
        userId,
        deviceId,
        revokedAt: null,
        'pushToken.token': mongoose.trusted({ $type: 'string' }),
      })
        .select('pushToken')
        .lean(),
      // Never notify a device whose user is signed out there.
      Session.exists({
        userId,
        deviceId,
        revokedAt: null,
        expiresAt: mongoose.trusted({ $gt: new Date() }),
      }),
    ]);
    if (!device || !signedIn) return 'no_target';

    const token = device.pushToken.token;
    const result = await pushProvider.send(buildMessage(token));
    if (!result.ok && result.error === 'DeviceNotRegistered') {
      // App uninstalled or token rotated: drop it (only if it is still the stored token).
      await Device.updateOne(
        { _id: device._id, 'pushToken.token': token },
        { $set: { pushToken: null } },
      );
    }
    if (!result.ok) logger.warn({ pushError: result.error }, 'Push notification rejected');
    return result.ok ? 'sent' : 'rejected';
  }

  function schedule(envelope) {
    if (!pushProvider) return;
    const run = new Promise((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
    })
      .then(() => notifyIfUndelivered(envelope._id))
      .catch((err) => {
        logger.warn({ err }, 'Push notification failed; message is still delivered by sync');
        return 'failed';
      });
    pending.add(run);
    run.finally(() => pending.delete(run));
  }

  /**
   * Incoming call: sent at once (a ringing call cannot wait for an ack delay). A phone that is
   * open gets the call over Pusher and does not show this as a banner (see the app's
   * notification handler); a backgrounded or closed one is woken by it. Best effort.
   */
  function notifyIncomingCall({ userId, deviceId, callId, kind, ttlSeconds }) {
    if (!pushProvider) return;
    const run = deliverToDevice(userId, deviceId, (token) =>
      buildCallPushMessage(token, { callId, kind, ttlSeconds }),
    ).catch((err) => {
      logger.warn({ err }, 'Incoming-call push failed; an open app still gets the call');
      return 'failed';
    });
    pending.add(run);
    run.finally(() => pending.delete(run));
  }

  /** Resolves when every scheduled notification has been handled (tests, graceful shutdown). */
  async function idle() {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  return { schedule, idle, notifyIfUndelivered, notifyIncomingCall };
}
