import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * Where media lives on the phone. Everything is in the app's PRIVATE internal storage
 * (Context.getFilesDir / getCacheDir on Android): never in shared storage (Pictures, DCIM,
 * Movies, Music, Downloads), so the media scanner and gallery or music apps never see it, other
 * apps cannot read it, and Android backup is off for the app (allowBackup=false).
 *
 *  - files/attachments/<id>.bin   encrypted blobs (AES-256-GCM), kept with the chat. Their keys
 *                                 are in the SQLCipher database, so a blob alone is unreadable.
 *  - cache/secure-media/          short-lived PLAINTEXT, only while a photo, video or voice note
 *                                 is on screen or playing; removed when the viewer closes, when
 *                                 the app goes to the background, at every start and at sign-out.
 *  - cache/ImagePicker, cache/Camera, cache/Audio
 *                                 the picker's copy of a chosen photo/video, photos and videos
 *                                 taken with the in-app camera, and fresh voice recordings:
 *                                 deleted once encrypted or discarded, and swept at start in
 *                                 case the app was killed in between.
 */
const ATTACHMENTS_DIR = 'attachments';
const PLAINTEXT_DIR = 'secure-media';
/** Plaintext the app itself created from the picker or the recorder (never the user's files). */
const INTAKE_DIRS = ['ImagePicker', 'Audio', 'Camera'];

const attachmentsDir = () => new Directory(Paths.document, ATTACHMENTS_DIR);
const plaintextDir = () => new Directory(Paths.cache, PLAINTEXT_DIR);

function ensure(dir) {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** The encrypted blob `name` in the attachments directory. */
export function attachmentFile(name) {
  return new File(attachmentsDir(), name);
}

/** A new, unused location for an encrypted blob: `{ name, file }`. */
export function newAttachmentFile() {
  ensure(attachmentsDir());
  const name = `${randomUUID()}.bin`;
  return { name, file: new File(attachmentsDir(), name) };
}

/** Where a partially downloaded blob is written before it is verified. */
export function partialDownloadFile(name) {
  ensure(attachmentsDir());
  return new File(attachmentsDir(), `${name}.part`);
}

/** A new temporary plaintext file for viewing (`extension` like "jpg"). */
export function newPlaintextFile(extension) {
  ensure(plaintextDir());
  const safe = /^[a-z0-9]{1,5}$/.test(extension) ? extension : 'bin';
  return new File(plaintextDir(), `${randomUUID()}.${safe}`);
}

/** Deletes a file if it exists; never throws (best-effort cleanup). */
export function deleteQuietly(fileOrUri) {
  try {
    const file = typeof fileOrUri === 'string' ? new File(fileOrUri) : fileOrUri;
    if (file?.exists) file.delete();
  } catch {
    // Already gone, or not ours to delete.
  }
}

/** True if `uri` is inside the app's cache directory (i.e. a copy the app made itself). */
export function isAppCacheFile(uri) {
  if (typeof uri !== 'string') return false;
  const root = Paths.cache.uri.replace(/\/?$/, '/');
  return uri.startsWith(root) && !uri.slice(root.length).split('/').includes('..');
}

function clearDirectory(dir, keep = () => false) {
  try {
    if (!dir.exists) return 0;
    let removed = 0;
    for (const entry of dir.list()) {
      if (keep(entry)) continue;
      entry.delete();
      removed += 1;
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Removes every temporary plaintext file (viewer copies). Safe at any time no viewer is open. */
export function clearPlaintextMedia() {
  return clearDirectory(plaintextDir());
}

/**
 * Start-up cleanup after a crash or kill: viewer plaintext, leftover picker copies and
 * recordings, and partial downloads. Encrypted blobs that belong to messages are kept.
 */
export function sweepMediaLeftovers() {
  let removed = clearPlaintextMedia();
  for (const name of INTAKE_DIRS) removed += clearDirectory(new Directory(Paths.cache, name));
  removed += clearDirectory(attachmentsDir(), (entry) => !entry.name.endsWith('.part'));
  return removed;
}

/**
 * Deletes encrypted blobs no message refers to (the app was killed after encrypting a file but
 * before storing its message). `isKnown(name)` says which ones to keep.
 */
export function removeUnreferencedBlobs(isKnown) {
  return clearDirectory(
    attachmentsDir(),
    (entry) => !entry.name.endsWith('.bin') || isKnown(entry.name),
  );
}

/** Sign-out / account deletion: every media file, encrypted or not, is removed. */
export function wipeAllMedia() {
  for (const dir of [
    attachmentsDir(),
    plaintextDir(),
    ...INTAKE_DIRS.map((n) => new Directory(Paths.cache, n)),
  ]) {
    try {
      if (dir.exists) dir.delete();
    } catch {
      // Best effort: without the database key the blobs are unreadable anyway.
    }
  }
}

/** For tests and diagnostics: the directories media may ever be written to. */
export const MEDIA_LOCATIONS = Object.freeze({
  attachments: () => attachmentsDir().uri,
  plaintext: () => plaintextDir().uri,
});
