import { ATTACHMENT, encryptedAttachmentSize, ERROR_CODE } from '@secure-chat/shared/constants';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { create } from 'zustand';

import { getMediaCrypto } from '../../modules/media-crypto';
import { ENDPOINTS } from '../config/endpoints';
import { ApiError, apiRequest, NetworkError } from '../lib/api';
import { attachmentContent } from '../messaging/content';
import { ATTACHMENT_STATE } from './attachmentStore';
import * as store from './attachmentStore';
import {
  attachmentFile,
  clearPlaintextMedia,
  deleteQuietly,
  isAppCacheFile,
  newAttachmentFile,
  newPlaintextFile,
  partialDownloadFile,
  removeUnreferencedBlobs,
  sweepMediaLeftovers,
} from './mediaFiles';
import { downloadFile, TransferSizeError, uploadFile } from './transfer';
import { WAVEFORM_PATTERN } from './waveform';

/**
 * Photos, videos and voice notes, end to end:
 *
 *  send:     pick/record (plaintext copy in the app cache)
 *            -> encrypt natively with a new random key into files/attachments (delete the copy)
 *            -> message + attachment rows (key, digest) in one SQLCipher transaction
 *            -> upload the encrypted blob (POST /attachments, pre-signed PUT, /complete), once:
 *               a retry reuses the same clientAttachmentId and the same blob
 *            -> the Signal message carries { id, key, digest, size, type, ... }
 *  receive:  Signal message -> attachment row (pending) -> download the blob (exact size)
 *            -> verify size, SHA-256 digest and GCM tag -> keep it encrypted -> tell the server
 *  view:     decrypt into a temporary private file only while it is on screen or playing
 *
 * The server only ever sees encrypted, padded blobs: no key, no type, no name, no exact size.
 */

export const MEDIA_ERROR = Object.freeze({
  TOO_LARGE: 'MEDIA_TOO_LARGE',
  UNSUPPORTED: 'MEDIA_UNSUPPORTED',
  /** The file to send (or a stored blob) is missing. */
  UNAVAILABLE: 'MEDIA_UNAVAILABLE',
  /** The server no longer has it (expired or deleted). */
  EXPIRED: 'EXPIRED',
  /** The download did not match its size, digest or tag. */
  CORRUPT: 'CORRUPT',
  TEMPORARY: 'TEMPORARY',
  FAILED: 'FAILED',
});

export class MediaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

/** UI-facing: bumped when attachment rows change or temporary plaintext was cleared. */
export const useMediaStore = create(() => ({ revision: 0, plaintextGeneration: 0 }));
const bumpMedia = () => useMediaStore.setState((s) => ({ revision: s.revision + 1 }));

/** image | video | audio for a MIME type, or null (not something the app sends or shows). */
export function mediaKindOf(contentType) {
  const match = /^(image|video|audio)\/[a-z0-9.+-]+$/i.exec(contentType ?? '');
  return match ? match[1].toLowerCase() : null;
}

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/3gpp': '3gp',
};
export const extensionFor = (contentType) => EXTENSIONS[contentType?.toLowerCase()] ?? 'bin';

const isIntegrityError = (err) =>
  err?.code === 'ERR_MEDIA_INTEGRITY' || err instanceof TransferSizeError;

// --- Sending ---

/**
 * Encrypts a picked photo/video or a recorded voice note into the attachments directory.
 * `media`: { uri, contentType, width?, height?, durationMs?, voiceNote? }. The plaintext copy is
 * deleted afterwards if the app made it (picker/recorder cache); the user's own files never are.
 *
 * @returns {Promise<object>} the attachment fields to store with the message
 */
export async function prepareAttachment(media) {
  const kind = mediaKindOf(media.contentType);
  if (!kind) throw new MediaError(MEDIA_ERROR.UNSUPPORTED, 'This kind of file cannot be sent');
  const source = new File(media.uri);
  try {
    if (!source.exists)
      throw new MediaError(MEDIA_ERROR.UNAVAILABLE, 'The file is no longer available');
    if (source.size > ATTACHMENT.MAX_BYTES) {
      throw new MediaError(MEDIA_ERROR.TOO_LARGE, 'Files up to 100 MB can be sent');
    }
    if (source.size === 0) throw new MediaError(MEDIA_ERROR.UNAVAILABLE, 'The file is empty');

    const { name, file } = newAttachmentFile();
    preparing.add(name); // until the caller has stored it (see cleanUpMediaFiles)
    let encrypted;
    try {
      encrypted = await getMediaCrypto().encryptFile(
        source.uri,
        file.uri,
        media.contentType.toLowerCase() === 'image/jpeg', // remove GPS location from photos
      );
      if (encrypted.encryptedSize !== encryptedAttachmentSize(encrypted.size)) {
        throw new MediaError(MEDIA_ERROR.FAILED, 'Encryption produced an unexpected size');
      }
    } catch (err) {
      preparing.delete(name);
      deleteQuietly(file);
      if (err instanceof MediaError) throw err;
      if (err?.code === 'ERR_MEDIA_SIZE') {
        throw new MediaError(MEDIA_ERROR.TOO_LARGE, 'Files up to 100 MB can be sent');
      }
      throw new MediaError(MEDIA_ERROR.FAILED, 'The file could not be encrypted');
    }
    return {
      direction: 'out',
      kind,
      voiceNote: kind === 'audio' && media.voiceNote === true,
      contentType: media.contentType.toLowerCase(),
      clientAttachmentId: randomUUID(),
      mediaKey: encrypted.key,
      digest: encrypted.digest,
      size: encrypted.size,
      width: positiveInt(media.width, 65_535),
      height: positiveInt(media.height, 65_535),
      durationMs: positiveInt(media.durationMs, 24 * 60 * 60 * 1000),
      waveform:
        kind === 'audio' && WAVEFORM_PATTERN.test(media.waveform ?? '') ? media.waveform : null,
      fileName: name,
      state: ATTACHMENT_STATE.ENCRYPTED,
    };
  } finally {
    // The plaintext copy is not needed any more, whatever happened.
    if (isAppCacheFile(source.uri)) deleteQuietly(source);
  }
}

function positiveInt(value, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= max ? n : null;
}

/** Blobs encrypted but not yet stored with their message: never swept. */
const preparing = new Set();

/** The prepared attachment is now in the database (or was discarded). */
export function settlePrepared(prepared, { stored }) {
  if (!prepared?.fileName) return;
  preparing.delete(prepared.fileName);
  if (!stored) deleteQuietly(attachmentFile(prepared.fileName));
}

/**
 * Makes sure the encrypted blob of an outgoing message is on the server; returns its server
 * attachment id, or null for a message without attachment. Idempotent: the same
 * clientAttachmentId always maps to the same server attachment, re-uploading only replaces the
 * same bytes, and an upload already completed is not repeated.
 *
 * Throws NetworkError (retry later) or ApiError/MediaError (permanent).
 */
const uploads = new Map();
export function ensureUploaded(clientMessageId, recipientUserId) {
  if (!uploads.has(clientMessageId)) {
    uploads.set(
      clientMessageId,
      runUpload(clientMessageId, recipientUserId).finally(() => uploads.delete(clientMessageId)),
    );
  }
  return uploads.get(clientMessageId);
}

async function runUpload(clientMessageId, recipientUserId) {
  const row = await store.getOutgoingAttachment(clientMessageId);
  if (!row) return null;
  if (row.state === ATTACHMENT_STATE.UPLOADED && row.attachmentId) return row;
  const file = attachmentFile(row.fileName);
  if (!file.exists)
    throw new MediaError(MEDIA_ERROR.UNAVAILABLE, 'The file is no longer available');

  const slot = await apiRequest('POST', ENDPOINTS.ATTACHMENTS.ROOT, {
    body: {
      clientAttachmentId: row.clientAttachmentId,
      recipientUserId,
      size: encryptedAttachmentSize(row.size),
    },
  });
  await store.updateAttachment(row.messageId, { attachmentId: slot.attachmentId });
  if (slot.status !== ATTACHMENT_STATE.UPLOADED) {
    await uploadFile(file, slot.upload);
    try {
      await apiRequest('POST', ENDPOINTS.ATTACHMENTS.complete(slot.attachmentId));
    } catch (err) {
      // The bytes did not (all) arrive: send them again next time.
      if (err instanceof ApiError && err.code === ERROR_CODE.ATTACHMENT_INCOMPLETE) {
        throw new NetworkError('Upload incomplete');
      }
      throw err;
    }
  }
  await store.updateAttachment(row.messageId, { state: ATTACHMENT_STATE.UPLOADED, error: null });
  bumpMedia();
  return { ...row, attachmentId: slot.attachmentId, state: ATTACHMENT_STATE.UPLOADED };
}

/** Signal content for an uploaded attachment (the caption is the message body). */
export function contentForAttachment(row, caption) {
  return attachmentContent({
    id: row.attachmentId,
    key: row.mediaKey,
    digest: row.digest,
    size: row.size,
    contentType: row.contentType,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    voiceNote: row.voiceNote ? true : undefined,
    waveform: row.voiceNote && row.waveform ? row.waveform : undefined,
    caption: caption || undefined,
  });
}

// --- Receiving ---

/** Attachment row fields for decrypted attachment content (null if the app cannot show it). */
export function incomingAttachmentFields(content) {
  const kind = mediaKindOf(content.contentType);
  if (!kind) return null;
  return {
    direction: 'in',
    kind,
    voiceNote: kind === 'audio' && content.voiceNote === true,
    contentType: content.contentType.toLowerCase(),
    attachmentId: content.id,
    mediaKey: content.key,
    digest: content.digest,
    size: content.size,
    width: content.width,
    height: content.height,
    durationMs: content.durationMs,
    waveform: kind === 'audio' && content.waveform ? content.waveform : null,
    state: ATTACHMENT_STATE.PENDING,
  };
}

/**
 * Downloads, verifies and stores (encrypted) one incoming attachment. Outcomes are recorded
 * on the row: downloaded; pending + TEMPORARY (offline, server trouble: retried automatically);
 * failed + EXPIRED (gone from the server) / CORRUPT (wrong size, digest or tag) / FAILED.
 * @returns {Promise<string>} the resulting state
 */
const downloads = new Map();
export function downloadAttachment(messageId) {
  if (!downloads.has(messageId)) {
    downloads.set(
      messageId,
      runDownload(messageId).finally(() => {
        downloads.delete(messageId);
        bumpMedia();
      }),
    );
  }
  return downloads.get(messageId);
}

async function runDownload(messageId) {
  const row = await store.getAttachment(messageId);
  if (!row || row.direction !== 'in') return null;
  if (row.state === ATTACHMENT_STATE.DOWNLOADED) return row.state;

  const name = `${randomUUID()}.bin`;
  const part = partialDownloadFile(name);
  try {
    const { download } = await apiRequest('GET', ENDPOINTS.ATTACHMENTS.byId(row.attachmentId));
    await downloadFile(download, part, { expectedBytes: encryptedAttachmentSize(row.size) });
    // Nothing is trusted until the digest from the Signal message and the GCM tag both match.
    await getMediaCrypto().verifyFile(part.uri, row.mediaKey, row.digest, row.size);
    await part.move(attachmentFile(name));
    await store.updateAttachment(messageId, {
      state: ATTACHMENT_STATE.DOWNLOADED,
      error: null,
      fileName: name,
    });
    // Lets the server drop its copy sooner. Best effort.
    apiRequest('POST', ENDPOINTS.ATTACHMENTS.received(row.attachmentId)).catch(() => {});
    return ATTACHMENT_STATE.DOWNLOADED;
  } catch (err) {
    deleteQuietly(part);
    const outcome = downloadFailure(err);
    await store.updateAttachment(messageId, outcome);
    if (outcome.error === MEDIA_ERROR.TEMPORARY) throw err; // lets the queue stop while offline
    return outcome.state;
  }
}

function downloadFailure(err) {
  if (
    err instanceof NetworkError ||
    (err instanceof ApiError && (err.status >= 500 || err.status === 429))
  ) {
    return { state: ATTACHMENT_STATE.PENDING, error: MEDIA_ERROR.TEMPORARY };
  }
  if (err instanceof ApiError && err.status === 404) {
    return { state: ATTACHMENT_STATE.FAILED, error: MEDIA_ERROR.EXPIRED };
  }
  if (isIntegrityError(err)) return { state: ATTACHMENT_STATE.FAILED, error: MEDIA_ERROR.CORRUPT };
  return { state: ATTACHMENT_STATE.FAILED, error: MEDIA_ERROR.FAILED };
}

/** Fetches every pending incoming attachment, oldest first; stops at the first temporary failure. */
let queue = null;
export function downloadPendingAttachments() {
  queue ??= (async () => {
    let done = 0;
    for (const messageId of await store.listPendingDownloads()) {
      try {
        await downloadAttachment(messageId);
        done += 1;
      } catch {
        break; // offline or server trouble: the next sync tries again
      }
    }
    return done;
  })().finally(() => {
    queue = null;
  });
  return queue;
}

/** The user tapped a failed download: try again now. */
export async function retryDownload(messageId) {
  await store.updateAttachment(messageId, { state: ATTACHMENT_STATE.PENDING, error: null });
  bumpMedia();
  return downloadAttachment(messageId).catch(() => ATTACHMENT_STATE.PENDING);
}

// --- Viewing ---

const openPlaintext = new Set();

/**
 * Decrypts an attachment into a temporary private file for viewing or playback. Call
 * `release()` as soon as it is no longer shown; everything is also cleared when the app goes to
 * the background, at start and at sign-out.
 *
 * @returns {Promise<{ uri: string, release: () => void }>}
 */
export async function openAttachment(messageId) {
  const row = await store.getAttachment(messageId);
  const ready =
    row?.fileName &&
    (row.direction === 'out' || row.state === ATTACHMENT_STATE.DOWNLOADED) &&
    attachmentFile(row.fileName).exists;
  if (!ready) throw new MediaError(MEDIA_ERROR.UNAVAILABLE, 'This media is not on this phone');
  const dest = newPlaintextFile(extensionFor(row.contentType));
  try {
    await getMediaCrypto().decryptFile(
      attachmentFile(row.fileName).uri,
      row.mediaKey,
      row.digest,
      row.size,
      dest.uri,
    );
  } catch (err) {
    deleteQuietly(dest);
    throw isIntegrityError(err)
      ? new MediaError(MEDIA_ERROR.CORRUPT, 'This media is damaged')
      : new MediaError(MEDIA_ERROR.FAILED, 'This media could not be opened');
  }
  openPlaintext.add(dest.uri);
  let released = false;
  return {
    uri: dest.uri,
    release() {
      if (released) return;
      released = true;
      openPlaintext.delete(dest.uri);
      deleteQuietly(dest);
    },
  };
}

/** Deletes all temporary plaintext (app backgrounded): viewers re-open on return. */
export function releaseAllPlaintext() {
  openPlaintext.clear();
  clearPlaintextMedia();
  useMediaStore.setState((s) => ({ plaintextGeneration: s.plaintextGeneration + 1 }));
}

/** Number of temporary plaintext files currently handed out (tests, diagnostics). */
export const openPlaintextCount = () => openPlaintext.size;

/**
 * Start of messaging: removes leftovers of a crash or kill (plaintext copies, partial
 * downloads, blobs that never made it into the database).
 */
export async function cleanUpMediaFiles() {
  sweepMediaLeftovers();
  const known = await store.listAttachmentFileNames();
  removeUnreferencedBlobs((name) => known.has(name) || preparing.has(name));
}
