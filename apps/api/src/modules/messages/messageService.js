import { ERROR_CODE, LIMITS, MESSAGE_STATUS } from '@secure-chat/shared/constants';
import mongoose from 'mongoose';

import { HttpError } from '../../middleware/errors.js';
import { nextSequence } from '../../models/Counter.js';
import { Device } from '../../models/Device.js';
import { directConversationId, Message } from '../../models/Message.js';
import { ENVELOPE_RETENTION, MessageEnvelope } from '../../models/MessageEnvelope.js';
import { publishEnvelope, publishReceipts } from '../../services/realtime/index.js';

/** Highest state reached, from metadata only. */
function statusOf(message) {
  if (message.readAt) return MESSAGE_STATUS.READ;
  if (message.deliveredAt) return MESSAGE_STATUS.DELIVERED;
  return MESSAGE_STATUS.SENT;
}

/**
 * Accepts already-encrypted Signal envelopes and routes them to the recipient device.
 * The server validates authorization and shape only; it cannot read message content.
 */
export function createMessageService({ realtime, pushNotifier, logger }) {
  function toClientEnvelope(envelope) {
    return {
      envelopeId: String(envelope._id),
      seq: envelope.seq,
      messageId: String(envelope.messageId),
      senderUserId: String(envelope.senderUserId),
      senderDeviceId: envelope.senderDeviceId,
      senderSignalDeviceId: envelope.senderSignalDeviceId,
      type: envelope.type,
      ciphertext: envelope.ciphertext,
      createdAt: envelope.createdAt,
    };
  }

  /** What the sender learns about an accepted message: ids, order and state. Never content. */
  function toSendResult(message, envelope, duplicate) {
    return {
      messageId: String(message._id),
      clientMessageId: message.clientMessageId,
      conversationId: message.conversationId,
      seq: envelope?.seq ?? null,
      status: statusOf(message),
      createdAt: message.createdAt,
      duplicate,
    };
  }

  // Idempotency: a retry (crash, timeout) with the same clientMessageId returns the original.
  async function findExisting(auth, input) {
    const existing = await Message.findOne({
      senderDeviceId: auth.deviceId,
      clientMessageId: input.clientMessageId,
    }).lean();
    if (!existing) return null;
    if (String(existing.recipientUserId) !== input.recipientUserId) {
      throw new HttpError(
        409,
        ERROR_CODE.VALIDATION_ERROR,
        'clientMessageId was already used for another recipient',
      );
    }
    const envelope = await MessageEnvelope.findOne({ messageId: existing._id }).lean();
    return toSendResult(existing, envelope, true);
  }

  async function sendEnvelope(auth, input) {
    if (input.recipientUserId === auth.userId) {
      throw new HttpError(400, ERROR_CODE.VALIDATION_ERROR, 'Cannot message yourself');
    }

    const existing = await findExisting(auth, input);
    if (existing) return existing;

    const [sender, recipient] = await Promise.all([
      Device.findOne({ userId: auth.userId, deviceId: auth.deviceId, revokedAt: null }).lean(),
      Device.findOne({
        userId: input.recipientUserId,
        deviceId: input.recipientDeviceId,
        revokedAt: null,
      }).lean(),
    ]);
    if (!sender) throw new HttpError(401, ERROR_CODE.DEVICE_REVOKED, 'This device was signed out');
    if (!sender.signal) {
      throw new HttpError(409, ERROR_CODE.KEYS_NOT_REGISTERED, 'Register device keys first');
    }
    const reRegistered =
      input.recipientRegistrationId !== undefined &&
      recipient?.signal?.registrationId !== input.recipientRegistrationId;
    if (!recipient?.signal || reRegistered) {
      // Recipient re-installed / switched device, or signed in again on the same install (new
      // keys under the same device id, so the sender's session is for keys that no longer
      // exist): the sender must fetch a fresh bundle. Nothing is stored.
      throw new HttpError(
        409,
        ERROR_CODE.STALE_RECIPIENT_DEVICE,
        'Recipient device changed; fetch a new key bundle',
      );
    }

    let created;
    try {
      await mongoose.connection.transaction(async (session) => {
        const [message] = await Message.create(
          [
            {
              senderUserId: auth.userId,
              senderDeviceId: auth.deviceId,
              recipientUserId: input.recipientUserId,
              clientMessageId: input.clientMessageId,
              conversationId: directConversationId(auth.userId, input.recipientUserId),
            },
          ],
          { session },
        );
        const seq = await nextSequence(`envelope:${recipient.deviceId}`, { session });
        const [envelope] = await MessageEnvelope.create(
          [
            {
              messageId: message._id,
              recipientUserId: recipient.userId,
              recipientDeviceId: recipient.deviceId,
              senderUserId: auth.userId,
              senderDeviceId: auth.deviceId,
              senderSignalDeviceId: sender.signalDeviceId,
              seq,
              type: input.type,
              ciphertext: input.ciphertext,
            },
          ],
          { session },
        );
        created = { message, envelope };
      });
    } catch (err) {
      // A concurrent retry with the same clientMessageId won the race: return its result.
      const duplicate = err?.code === 11000 && (await findExisting(auth, input));
      if (duplicate) return duplicate;
      throw err;
    }

    // After commit: realtime is best effort, MongoDB already has the envelope.
    await publishEnvelope(realtime, logger, created.envelope);
    // Push only if the device does not ack via realtime shortly (closed/backgrounded app).
    pushNotifier?.schedule(created.envelope);
    return toSendResult(created.message, created.envelope, false);
  }

  async function listEnvelopes(auth, { after, limit }) {
    const envelopes = await MessageEnvelope.find({
      recipientDeviceId: auth.deviceId,
      recipientUserId: auth.userId,
      seq: mongoose.trusted({ $gt: after }),
      deliveredAt: null,
    })
      .sort({ seq: 1 })
      .limit(Math.min(limit, LIMITS.PAGE_SIZE_MAX))
      .lean();
    return envelopes.map(toClientEnvelope);
  }

  /**
   * Marks everything up to `upToSeq` as delivered to this device (the device calls this only
   * after storing/processing the envelopes), records delivery on the messages and notifies the
   * senders. Envelopes are kept for ENVELOPE_RETENTION.DELIVERED_MS, not deleted.
   */
  async function ackEnvelopes(auth, upToSeq) {
    const pending = await MessageEnvelope.find({
      recipientDeviceId: auth.deviceId,
      recipientUserId: auth.userId,
      seq: mongoose.trusted({ $lte: upToSeq }),
      deliveredAt: null,
    })
      .select('messageId senderDeviceId')
      .lean();
    if (pending.length === 0) return { acknowledged: 0 };

    const now = new Date();
    const result = await MessageEnvelope.updateMany(
      { _id: mongoose.trusted({ $in: pending.map((e) => e._id) }), deliveredAt: null },
      {
        $set: {
          deliveredAt: now,
          expiresAt: new Date(now.getTime() + ENVELOPE_RETENTION.DELIVERED_MS),
        },
      },
    );
    await Message.updateMany(
      { _id: mongoose.trusted({ $in: pending.map((e) => e.messageId) }), deliveredAt: null },
      { $set: { deliveredAt: now } },
    );

    await publishReceipts(
      realtime,
      logger,
      pending.map((envelope) => ({
        senderDeviceId: envelope.senderDeviceId,
        messageId: String(envelope.messageId),
        status: MESSAGE_STATUS.DELIVERED,
        at: now,
      })),
    );
    return { acknowledged: result.modifiedCount };
  }

  /** Recipient marks messages as read. Only messages addressed to the caller are affected. */
  async function markRead(auth, messageIds) {
    const unread = await Message.find({
      _id: mongoose.trusted({ $in: messageIds }),
      recipientUserId: auth.userId,
      readAt: null,
    })
      .select('senderDeviceId')
      .lean();
    if (unread.length === 0) return { updated: 0 };

    const now = new Date();
    const ids = unread.map((m) => m._id);
    // Read implies delivered (e.g. the ack was lost but the message is on screen).
    await Message.updateMany(
      { _id: mongoose.trusted({ $in: ids }), deliveredAt: null },
      { $set: { deliveredAt: now } },
    );
    const result = await Message.updateMany(
      { _id: mongoose.trusted({ $in: ids }), readAt: null },
      { $set: { readAt: now } },
    );

    await publishReceipts(
      realtime,
      logger,
      unread.map((message) => ({
        senderDeviceId: message.senderDeviceId,
        messageId: String(message._id),
        status: MESSAGE_STATUS.READ,
        at: now,
      })),
    );
    return { updated: result.modifiedCount };
  }

  /** Current state of the caller's own sent messages (receipt recovery after being offline). */
  async function getStatuses(auth, messageIds) {
    const messages = await Message.find({
      _id: mongoose.trusted({ $in: messageIds }),
      senderUserId: auth.userId,
    })
      .select('clientMessageId deliveredAt readAt')
      .lean();
    return messages.map((message) => ({
      messageId: String(message._id),
      clientMessageId: message.clientMessageId,
      status: statusOf(message),
      deliveredAt: message.deliveredAt,
      readAt: message.readAt,
    }));
  }

  return { sendEnvelope, listEnvelopes, ackEnvelopes, markRead, getStatuses };
}
