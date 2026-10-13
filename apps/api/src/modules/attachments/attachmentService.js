import { ERROR_CODE } from '@secure-chat/shared/constants';
import mongoose from 'mongoose';

import { HttpError } from '../../middleware/errors.js';
import { Attachment, ATTACHMENT_RETENTION, ATTACHMENT_STATUS } from '../../models/Attachment.js';
import { User } from '../../models/User.js';

const MIB = 1024 * 1024;
const notFound = () =>
  new HttpError(404, ERROR_CODE.ATTACHMENT_NOT_FOUND, 'Attachment not found or expired');

/**
 * Encrypted attachment blobs: metadata here (MongoDB), bytes in attachment storage.
 *
 * The server never sees the media key or the plaintext: the phone encrypts before uploading and
 * sends the key to the recipient inside the Signal message. What the server enforces:
 *  - who may upload (any signed-in device, for one named recipient), how much (size cap and a
 *    per-user byte budget) and how often;
 *  - that a retried upload reuses the same attachment (`clientAttachmentId`), never a duplicate;
 *  - that an attachment is downloadable only after its upload is complete, only by the uploader
 *    or the named recipient, and only until it expires;
 *  - retention: blobs are deleted (blob first, then metadata) when they expire.
 *
 * @param {{
 *   storage: ReturnType<typeof import('../../services/storage/index.js').createAttachmentStorage>,
 *   rateLimiters: ReturnType<typeof import('../../middleware/rateLimit.js').createRateLimiters>,
 *   config: { sweepIntervalSeconds: number },
 *   logger: import('pino').Logger,
 * }} deps
 */
export function createAttachmentService({ storage, rateLimiters, config, logger }) {
  const uploadResult = (doc) => ({
    attachmentId: String(doc._id),
    status: doc.status,
    size: doc.size,
    ...(doc.status === ATTACHMENT_STATUS.PENDING && {
      upload: storage.uploadTarget(doc.storageKey, doc.size),
    }),
  });

  async function findOwn(auth, clientAttachmentId) {
    return Attachment.findOne({ uploaderDeviceId: auth.deviceId, clientAttachmentId }).lean();
  }

  /** The same request again (retry) returns the same attachment; anything else is refused. */
  function checkRetry(doc, input) {
    if (String(doc.recipientUserId) !== input.recipientUserId || doc.size !== input.size) {
      throw new HttpError(
        409,
        ERROR_CODE.VALIDATION_ERROR,
        'clientAttachmentId was already used for another upload',
      );
    }
    return uploadResult(doc);
  }

  /**
   * Reserves an upload slot (or returns the existing one for a retry) and a pre-signed upload
   * URL for exactly `size` bytes.
   */
  async function createUpload(auth, input) {
    if (input.recipientUserId === auth.userId) {
      throw new HttpError(400, ERROR_CODE.VALIDATION_ERROR, 'Cannot send to yourself');
    }
    const existing = await findOwn(auth, input.clientAttachmentId);
    if (existing) return checkRetry(existing, input);

    if (!(await User.exists({ _id: input.recipientUserId }))) {
      throw new HttpError(404, ERROR_CODE.NOT_FOUND, 'Recipient not found');
    }
    // Byte budget, counted for new uploads only (a retry costs nothing extra).
    await rateLimiters.consume(
      'attachmentMegabytesPerUser',
      auth.userId,
      Math.max(1, Math.ceil(input.size / MIB)),
    );

    try {
      const doc = await Attachment.create({
        uploaderUserId: auth.userId,
        uploaderDeviceId: auth.deviceId,
        recipientUserId: input.recipientUserId,
        clientAttachmentId: input.clientAttachmentId,
        storageKey: storage.newStorageKey(),
        size: input.size,
      });
      return uploadResult(doc.toObject());
    } catch (err) {
      // A concurrent retry with the same clientAttachmentId won the race.
      if (err?.code === 11000) {
        const raced = await findOwn(auth, input.clientAttachmentId);
        if (raced) return checkRetry(raced, input);
      }
      throw err;
    }
  }

  /**
   * The uploader says the upload finished. Accepted only if storage holds a blob of exactly
   * the declared size. Idempotent.
   */
  async function completeUpload(auth, attachmentId) {
    const doc = await Attachment.findOne({
      _id: attachmentId,
      uploaderUserId: auth.userId,
      uploaderDeviceId: auth.deviceId,
    }).lean();
    if (!doc || doc.expiresAt <= new Date()) throw notFound();
    if (doc.status === ATTACHMENT_STATUS.UPLOADED) return uploadResult(doc);

    const stored = await storage.stat(doc.storageKey);
    if (stored?.size !== doc.size) {
      throw new HttpError(409, ERROR_CODE.ATTACHMENT_INCOMPLETE, 'The upload is not complete');
    }
    const now = new Date();
    const updated = await Attachment.findOneAndUpdate(
      { _id: doc._id },
      {
        $set: {
          status: ATTACHMENT_STATUS.UPLOADED,
          uploadedAt: now,
          expiresAt: new Date(now.getTime() + ATTACHMENT_RETENTION.UPLOADED_MS),
        },
      },
      { new: true },
    ).lean();
    if (!updated) throw notFound();
    return uploadResult(updated);
  }

  /** Visible to the uploader and the recipient only; everyone else gets the same 404. */
  async function findReadable(auth, attachmentId) {
    const doc = await Attachment.findOne({
      _id: attachmentId,
      status: ATTACHMENT_STATUS.UPLOADED,
      expiresAt: mongoose.trusted({ $gt: new Date() }),
      $or: [{ recipientUserId: auth.userId }, { uploaderUserId: auth.userId }],
    }).lean();
    if (!doc) throw notFound();
    return doc;
  }

  /** A pre-signed download URL for an attachment the caller may read. */
  async function getDownload(auth, attachmentId) {
    const doc = await findReadable(auth, attachmentId);
    return {
      attachmentId: String(doc._id),
      size: doc.size,
      download: storage.downloadTarget(doc.storageKey),
    };
  }

  /**
   * The recipient's phone stored its own encrypted copy: keep the server copy only for the
   * short grace period from now on (never longer than it would have been kept anyway).
   */
  async function markReceived(auth, attachmentId) {
    const doc = await Attachment.findOne({
      _id: attachmentId,
      recipientUserId: auth.userId,
      status: ATTACHMENT_STATUS.UPLOADED,
    }).lean();
    if (!doc) throw notFound();
    const now = new Date();
    const graceUntil = new Date(now.getTime() + ATTACHMENT_RETENTION.DOWNLOADED_MS);
    await Attachment.updateOne(
      { _id: doc._id, downloadedAt: null },
      { $set: { downloadedAt: now } },
    );
    await Attachment.updateOne(
      { _id: doc._id, expiresAt: mongoose.trusted({ $gt: graceUntil }) },
      { $set: { expiresAt: graceUntil } },
    );
  }

  /**
   * Deletes expired attachments: blob first, then metadata, so a crash in between leaves
   * metadata that is retried, never an orphaned blob. Safe to run on several instances.
   * @returns {Promise<number>} attachments deleted
   */
  async function sweepExpired({ limit = 500 } = {}) {
    const expired = await Attachment.find({ expiresAt: mongoose.trusted({ $lte: new Date() }) })
      .select('storageKey')
      .limit(limit)
      .lean();
    let deleted = 0;
    for (const doc of expired) {
      try {
        await storage.remove(doc.storageKey);
        const result = await Attachment.deleteOne({
          _id: doc._id,
          expiresAt: mongoose.trusted({ $lte: new Date() }),
        });
        deleted += result.deletedCount;
      } catch (err) {
        logger.error({ err }, 'Could not delete an expired attachment; retried next sweep');
      }
    }
    if (deleted > 0) logger.info({ deleted }, 'Expired attachments deleted');
    return deleted;
  }

  /**
   * Account deletion (inside its transaction): attachments sent TO the user, and the user's own
   * unfinished uploads, expire now. Uploaded attachments the user sent to others stay until
   * they expire, like envelopes already sent.
   */
  async function expireForDeletedUser(userId, { session }) {
    await Attachment.updateMany(
      mongoose.trusted({
        $or: [
          { recipientUserId: userId },
          { uploaderUserId: userId, status: ATTACHMENT_STATUS.PENDING },
        ],
      }),
      { $set: { expiresAt: new Date() } },
      { session },
    );
  }

  /** Declared size of a pending upload (local storage's PUT endpoint checks it). */
  async function pendingUploadSize(storageKey) {
    const doc = await Attachment.findOne({
      storageKey,
      status: ATTACHMENT_STATUS.PENDING,
      expiresAt: mongoose.trusted({ $gt: new Date() }),
    })
      .select('size')
      .lean();
    return doc?.size ?? null;
  }

  let sweeper = null;
  function startSweeper() {
    if (sweeper || config.sweepIntervalSeconds <= 0) return;
    sweeper = setInterval(() => {
      sweepExpired().catch((err) => logger.error({ err }, 'Attachment sweep failed'));
    }, config.sweepIntervalSeconds * 1000);
    sweeper.unref();
  }
  function stopSweeper() {
    clearInterval(sweeper);
    sweeper = null;
  }

  return {
    createUpload,
    completeUpload,
    getDownload,
    markReceived,
    sweepExpired,
    expireForDeletedUser,
    pendingUploadSize,
    startSweeper,
    stopSweeper,
    storage,
  };
}
