import mongoose from 'mongoose';

/**
 * Ciphertext retention. Envelopes are kept after acknowledgement for a grace period (not deleted
 * on ack), and undelivered ones expire eventually so an abandoned device does not keep
 * ciphertext on the server forever. MongoDB's TTL monitor removes documents past `expiresAt`.
 */
export const ENVELOPE_RETENTION = Object.freeze({
  UNDELIVERED_MS: 30 * 24 * 60 * 60 * 1000,
  DELIVERED_MS: 7 * 24 * 60 * 60 * 1000,
});

/**
 * Per-recipient-device ciphertext (Signal message) plus delivery metadata.
 * `seq` is a per-device monotonic counter used as the sync cursor.
 */
const messageEnvelopeSchema = new mongoose.Schema(
  {
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipientDeviceId: { type: String, required: true },
    senderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderDeviceId: { type: String, required: true },
    senderSignalDeviceId: { type: Number, required: true },
    seq: { type: Number, required: true },
    /** libsignal CiphertextMessage type: 2 = SignalMessage, 3 = PreKeySignalMessage. */
    type: { type: Number, required: true },
    /** Base64 Signal ciphertext. Opaque to the server. */
    ciphertext: { type: String, required: true },
    deliveredAt: { type: Date, default: null },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + ENVELOPE_RETENTION.UNDELIVERED_MS),
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageEnvelopeSchema.index({ recipientDeviceId: 1, seq: 1 }, { unique: true });
messageEnvelopeSchema.index({ messageId: 1, recipientDeviceId: 1 }, { unique: true });
messageEnvelopeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const MessageEnvelope =
  mongoose.models.MessageEnvelope ?? mongoose.model('MessageEnvelope', messageEnvelopeSchema);
