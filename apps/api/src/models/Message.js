import mongoose from 'mongoose';

/** How long message metadata (no content) is kept for receipts and idempotency. */
export const MESSAGE_METADATA_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Stable id of the 1:1 conversation between two users (order independent). */
export const directConversationId = (userIdA, userIdB) =>
  [String(userIdA), String(userIdB)].sort().join(':');

/**
 * Message metadata only. There is deliberately no content field: the encrypted payload lives
 * in MessageEnvelope (one per recipient device) and the server never has the plaintext.
 * Delivery and read state come from device acknowledgements, never from message content.
 */
const messageSchema = new mongoose.Schema(
  {
    senderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderDeviceId: { type: String, required: true },
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Client idempotency key; retries after a crash return the original message. */
    clientMessageId: { type: String, required: true },
    /** `directConversationId(sender, recipient)` for 1:1 chats. */
    conversationId: { type: String, default: null },
    /** Group chats (later phase) will reference a Chat document here. */
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', default: null },
    /** Set when the recipient device acknowledged (processed) the envelope. */
    deliveredAt: { type: Date, default: null },
    /** Set when the recipient opened the conversation and saw the message. */
    readAt: { type: Date, default: null },
    /** TTL: metadata is removed after MESSAGE_METADATA_RETENTION_MS. */
    expiresAt: { type: Date, default: () => new Date(Date.now() + MESSAGE_METADATA_RETENTION_MS) },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.index({ senderDeviceId: 1, clientMessageId: 1 }, { unique: true });
messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Message = mongoose.models.Message ?? mongoose.model('Message', messageSchema);
