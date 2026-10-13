import mongoose from 'mongoose';

/**
 * How long encrypted attachment blobs are kept. Like envelopes: an upload nobody completed is
 * dropped quickly, an uploaded blob waits for the recipient, and one the recipient confirmed
 * downloading is kept only for a short grace period (their phone has its own encrypted copy).
 */
export const ATTACHMENT_RETENTION = Object.freeze({
  PENDING_MS: 24 * 60 * 60 * 1000,
  UPLOADED_MS: 30 * 24 * 60 * 60 * 1000,
  DOWNLOADED_MS: 7 * 24 * 60 * 60 * 1000,
});

export const ATTACHMENT_STATUS = Object.freeze({ PENDING: 'pending', UPLOADED: 'uploaded' });

/**
 * Metadata of one encrypted attachment blob. The blob itself is in attachment storage under
 * `storageKey` (random; not derived from any id). The server never has the media key, the
 * plaintext, the file type or the real size: `size` is the size of the encrypted, padded blob.
 *
 * Expired documents are removed by attachmentService.sweepExpired (not a TTL index), which
 * deletes the blob first, so no blob outlives its metadata.
 */
const attachmentSchema = new mongoose.Schema(
  {
    uploaderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    uploaderDeviceId: { type: String, required: true },
    /** The only other user allowed to download it. */
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Uploader's idempotency key: a retried upload reuses this document and its blob. */
    clientAttachmentId: { type: String, required: true },
    storageKey: { type: String, required: true, unique: true },
    size: { type: Number, required: true },
    status: {
      type: String,
      enum: Object.values(ATTACHMENT_STATUS),
      default: ATTACHMENT_STATUS.PENDING,
    },
    uploadedAt: { type: Date, default: null },
    downloadedAt: { type: Date, default: null },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + ATTACHMENT_RETENTION.PENDING_MS),
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

attachmentSchema.index({ uploaderDeviceId: 1, clientAttachmentId: 1 }, { unique: true });
attachmentSchema.index({ expiresAt: 1 });
attachmentSchema.index({ recipientUserId: 1 });

export const Attachment =
  mongoose.models.Attachment ?? mongoose.model('Attachment', attachmentSchema);
