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
    title: 'Secure Chat',
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
export function createPushNotifier({ pushProvider, delayMs, logger }) {
  const pending = new Set();

  async function notifyIfUndelivered(envelopeId) {
    const envelope = await MessageEnvelope.findById(envelopeId)
      .select('messageId recipientUserId recipientDeviceId deliveredAt')
      .lean();
    if (!envelope || envelope.deliveredAt) return 'delivered';

    const { recipientUserId: userId, recipientDeviceId: deviceId } = envelope;
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
    const result = await pushProvider.send(buildPushMessage(token, envelope));
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

  /** Resolves when every scheduled notification has been handled (tests, graceful shutdown). */
  async function idle() {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  return { schedule, idle, notifyIfUndelivered };
}
