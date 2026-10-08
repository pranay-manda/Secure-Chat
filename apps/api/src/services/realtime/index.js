import { CHANNEL_PREFIX, LIMITS, REALTIME_EVENT } from '@secure-chat/shared/constants';
import Pusher from 'pusher';

/**
 * Realtime delivery abstraction (architecture §19: isolate Pusher behind a service).
 * MongoDB stays the source of truth; a missed realtime event is recovered by sync.
 *
 * @typedef {{ publish(channel: string, event: string, payload: object): Promise<void> }} Realtime
 */

export const deviceChannel = (deviceId) => `${CHANNEL_PREFIX.DEVICE}${deviceId}`;

const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Receipts per realtime event: keeps each event far below Pusher's 10 KB limit. */
const RECEIPTS_PER_EVENT = 50;

/**
 * Builds the `envelope` event for a recipient device. Carries the encrypted envelope inline
 * only while it fits under the inline limit; otherwise only ids, and the device fetches the
 * envelope over HTTPS (GET /messages/envelopes). Never contains plaintext: the server has none.
 */
export function buildEnvelopeEvent(envelope) {
  const reference = { envelopeId: String(envelope._id), seq: envelope.seq };
  const inline = {
    ...reference,
    inline: true,
    envelope: {
      messageId: String(envelope.messageId),
      senderUserId: String(envelope.senderUserId),
      senderDeviceId: envelope.senderDeviceId,
      senderSignalDeviceId: envelope.senderSignalDeviceId,
      type: envelope.type,
      ciphertext: envelope.ciphertext,
      createdAt: envelope.createdAt,
    },
  };
  return byteLength(inline) <= LIMITS.PUSHER_INLINE_PAYLOAD_BYTES
    ? inline
    : { ...reference, inline: false };
}

const createPusherClient = (config) =>
  new Pusher({
    appId: config.appId,
    key: config.key,
    secret: config.secret,
    cluster: config.cluster,
    useTLS: true,
  });

function createPusherRealtime(config) {
  const pusher = createPusherClient(config);
  return {
    async publish(channel, event, payload) {
      await pusher.trigger(channel, event, payload);
    },
  };
}

/** Used when Pusher is not configured: delivery then relies on sync (still correct). */
function createNoopRealtime() {
  return { async publish() {} };
}

/**
 * @param {{ appId: string, key: string, secret: string, cluster: string } | null} pusherConfig
 */
export function createRealtime(pusherConfig) {
  return pusherConfig ? createPusherRealtime(pusherConfig) : createNoopRealtime();
}

/**
 * Signs private-channel subscriptions (pure HMAC with the Pusher secret, no network call).
 * The secret never leaves the server; clients only ever receive the public key and cluster.
 * Returns null when Pusher is not configured.
 *
 * @param {{ appId: string, key: string, secret: string, cluster: string } | null} pusherConfig
 */
export function createChannelAuthorizer(pusherConfig) {
  if (!pusherConfig) return null;
  const pusher = createPusherClient(pusherConfig);
  return {
    publicConfig: Object.freeze({ key: pusherConfig.key, cluster: pusherConfig.cluster }),
    /** @returns {{ auth: string }} */
    authorize(socketId, channelName) {
      return pusher.authorizeChannel(socketId, channelName);
    },
  };
}

/**
 * Publishes an envelope notification to the recipient device. Failures are logged, not thrown:
 * the envelope is already durable in MongoDB and the device will get it on its next sync.
 */
export async function publishEnvelope(realtime, logger, envelope) {
  try {
    await realtime.publish(
      deviceChannel(envelope.recipientDeviceId),
      REALTIME_EVENT.ENVELOPE,
      buildEnvelopeEvent(envelope),
    );
  } catch (err) {
    logger.warn({ err, seq: envelope.seq }, 'Realtime publish failed; client will sync');
  }
}

/**
 * Tells sender devices that messages were delivered or read. Best effort like envelopes:
 * senders also poll POST /messages/status, so a lost receipt only delays the tick.
 *
 * @param {Array<{ senderDeviceId: string, messageId: string, status: string, at: Date }>} receipts
 */
export async function publishReceipts(realtime, logger, receipts) {
  const byDevice = new Map();
  for (const { senderDeviceId, ...receipt } of receipts) {
    if (!byDevice.has(senderDeviceId)) byDevice.set(senderDeviceId, []);
    byDevice.get(senderDeviceId).push(receipt);
  }

  const sends = [];
  for (const [deviceId, list] of byDevice) {
    for (let i = 0; i < list.length; i += RECEIPTS_PER_EVENT) {
      sends.push(
        realtime.publish(deviceChannel(deviceId), REALTIME_EVENT.RECEIPT, {
          receipts: list.slice(i, i + RECEIPTS_PER_EVENT),
        }),
      );
    }
  }
  const results = await Promise.allSettled(sends);
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) {
    logger.warn({ err: failed[0].reason, failed: failed.length }, 'Receipt publish failed');
  }
}
