import { CIPHERTEXT_TYPE, ERROR_CODE, LIMITS, SIGNAL } from '@secure-chat/shared/constants';
import { deviceIdSchema } from '@secure-chat/shared/validation';
import { randomUUID } from 'expo-crypto';

import { getSignalNative } from '../../modules/signal-protocol';
import { ENDPOINTS } from '../config/endpoints';
import { ApiError, apiRequest, NetworkError } from '../lib/api';
import {
  contentForAttachment,
  ensureUploaded,
  incomingAttachmentFields,
  MediaError,
  settlePrepared,
} from '../media/attachmentService';
import * as attachments from '../media/attachmentStore';
import { CONTENT_TYPE, decodeContent, encodeContent, textContent } from '../messaging/content';
import * as messages from '../messaging/messageStore';
import {
  INVALID_CONTENT,
  LOCAL_STATUS,
  UNSUPPORTED_CONTENT,
  UNTRUSTED_IDENTITY,
} from '../messaging/messageStore';
import { base64ToBytes, bytesToBase64 } from './encoding';
import * as store from './signalStore';

/**
 * E2EE foundation (Phase 3A). All cryptography is done by the official libsignal through the
 * native module; this file only orchestrates calls and persistence. The server receives public
 * keys and ciphertext, never private keys or plaintext.
 */

const NEXT_PREKEY_ID = 'next_prekey_id';
const ENVELOPE_CURSOR = 'envelope_cursor';
/** Envelope error: it decrypted to internal content, which is never a chat message. */
const INTERNAL_CONTENT = 'INTERNAL_CONTENT';

const randomKeyId = () => 1 + Math.floor(Math.random() * (SIGNAL.MAX_KEY_ID - 1));

async function localContext(userId) {
  const identity = await store.loadIdentity();
  if (!identity) throw new Error('Signal identity not initialized');
  return {
    identityKeyPair: identity.identityKeyPair,
    registrationId: identity.registrationId,
    name: userId,
    deviceId: SIGNAL.DEFAULT_DEVICE_ID,
  };
}

async function ensureIdentity() {
  let identity = await store.loadIdentity();
  if (!identity) {
    identity = await getSignalNative().generateIdentity();
    await store.saveIdentity(identity);
  }
  return identity;
}

async function nextPreKeyIds(count) {
  const stored = Number(await store.getSyncValue(NEXT_PREKEY_ID));
  let start = Number.isInteger(stored) && stored > 0 ? stored : randomKeyId();
  if (start + count > SIGNAL.MAX_KEY_ID) start = 1;
  await store.setSyncValue(NEXT_PREKEY_ID, start + count);
  return start;
}

async function generateOneTimePreKeys(count) {
  const start = await nextPreKeyIds(count);
  const preKeys = await getSignalNative().generatePreKeys(start, count);
  await store.savePreKeys(preKeys);
  return preKeys.map(({ keyId, publicKey }) => ({ keyId, publicKey })); // public halves only
}

/**
 * Makes sure this device has an identity and its public keys are registered with the server.
 * Idempotent; also tops up one-time pre-keys when the server pool runs low.
 */
let registrationInFlight = null;
export function ensureKeysRegistered() {
  // Single-flight: concurrent callers share one registration (avoids racing key uploads).
  registrationInFlight ??= registerKeys().finally(() => {
    registrationInFlight = null;
  });
  return registrationInFlight;
}

async function registerKeys() {
  const identity = await ensureIdentity();
  let { status } = await apiRequest('GET', ENDPOINTS.KEYS.STATUS);

  if (!status.registered) {
    const { signed, kyber } = await newSignedAndKyberPreKeys(identity);
    const oneTimePreKeys = await generateOneTimePreKeys(SIGNAL.ONE_TIME_PREKEY_BATCH);

    const result = await apiRequest('PUT', ENDPOINTS.KEYS.ROOT, {
      body: {
        registrationId: identity.registrationId,
        identityKey: identity.identityKey,
        signedPreKey: pickPublic(signed),
        kyberPreKey: pickPublic(kyber),
        oneTimePreKeys,
      },
    });
    return result.status;
  }

  // Best effort: a failed rotation (offline, server error) is retried next time and never
  // blocks messaging; the current keys stay valid meanwhile.
  status = (await rotateSignedPreKeysIfDue(identity, status).catch(() => null)) ?? status;

  if (status.oneTimePreKeyCount < SIGNAL.ONE_TIME_PREKEY_LOW_WATERMARK) {
    const preKeys = await generateOneTimePreKeys(SIGNAL.ONE_TIME_PREKEY_BATCH);
    return (await apiRequest('POST', ENDPOINTS.KEYS.ONE_TIME, { body: { preKeys } })).status;
  }
  return status;
}

/** A key id not used by any stored key of that kind (an id collision would overwrite a key). */
async function unusedKeyId(kind) {
  const used = new Set(await store.listRotatedPreKeyIds(kind));
  let keyId;
  do keyId = randomKeyId();
  while (used.has(keyId));
  return keyId;
}

/** Generates (libsignal) and stores a new signed EC pre-key and Kyber last-resort pre-key. */
async function newSignedAndKyberPreKeys(identity) {
  const native = getSignalNative();
  const signed = await native.generateSignedPreKey(
    identity.identityKeyPair,
    await unusedKeyId('signed'),
  );
  const kyber = await native.generateKyberPreKey(
    identity.identityKeyPair,
    await unusedKeyId('kyber'),
  );
  await store.inTransaction(async () => {
    await store.saveSignedPreKey(signed);
    await store.saveKyberPreKey(kyber);
  });
  return { signed, kyber };
}

/**
 * Replaces the signed and Kyber pre-keys every SIGNAL.SIGNED_PREKEY_ROTATION_MS, and also when
 * the server is not serving this device's newest ones (e.g. an earlier upload failed). Replaced
 * private keys are kept for SIGNAL.SIGNED_PREKEY_RETENTION_MS (in-flight first messages), then
 * deleted, so a later compromise of the phone cannot decrypt old first messages that were
 * encrypted without a one-time pre-key. The keys the server serves are never deleted.
 * @returns {Promise<object|null>} the new server status if keys were uploaded
 */
async function rotateSignedPreKeysIfDue(identity, status) {
  const [signed, kyber] = await Promise.all([
    store.newestRotatedPreKey('signed'),
    store.newestRotatedPreKey('kyber'),
  ]);
  const age = (key) => (key ? Date.now() - key.createdAt : Infinity);
  const due =
    age(signed) >= SIGNAL.SIGNED_PREKEY_ROTATION_MS ||
    age(kyber) >= SIGNAL.SIGNED_PREKEY_ROTATION_MS;
  const serverBehind =
    (status.signedPreKeyId != null && status.signedPreKeyId !== signed?.keyId) ||
    (status.kyberPreKeyId != null && status.kyberPreKeyId !== kyber?.keyId);

  let uploaded = null;
  if (due || serverBehind) {
    const next = await newSignedAndKyberPreKeys(identity);
    uploaded = (
      await apiRequest('PUT', ENDPOINTS.KEYS.ROOT, {
        body: {
          registrationId: identity.registrationId,
          identityKey: identity.identityKey,
          signedPreKey: pickPublic(next.signed),
          kyberPreKey: pickPublic(next.kyber),
        },
      })
    ).status;
  }

  const served = uploaded ?? status;
  await store.pruneRotatedPreKeys('signed', SIGNAL.SIGNED_PREKEY_RETENTION_MS, [
    served.signedPreKeyId,
  ]);
  await store.pruneRotatedPreKeys('kyber', SIGNAL.SIGNED_PREKEY_RETENTION_MS, [
    served.kyberPreKeyId,
  ]);
  return uploaded;
}

function pickPublic({ keyId, publicKey, signature }) {
  return { keyId, publicKey, signature };
}

/** Error raised when a peer's identity key changed and the user has not accepted it yet. */
function untrustedIdentityError() {
  const err = new Error("The contact's security code changed");
  err.code = UNTRUSTED_IDENTITY;
  return err;
}

/**
 * Starts a session with a peer from their public pre-key bundle (PQXDH via libsignal).
 * libsignal refuses a bundle whose identity key differs from the trusted one; that change is
 * recorded for the user to review and the trusted key is left as it is.
 */
async function establishSession(local, peerUserId) {
  const { bundle } = await apiRequest('GET', ENDPOINTS.KEYS.bundle(peerUserId));
  const address = store.addressOf(peerUserId, bundle.signalDeviceId);
  const trustedIdentityKey = await store.loadPeerIdentity(address);
  let result;
  try {
    result = await getSignalNative().processPreKeyBundle(
      local,
      { name: peerUserId, deviceId: bundle.signalDeviceId, identityKey: trustedIdentityKey },
      bundle,
    );
  } catch (err) {
    if (err?.code === UNTRUSTED_IDENTITY) {
      await store.recordIdentityChange(peerUserId, address, trustedIdentityKey, bundle.identityKey);
      throw untrustedIdentityError();
    }
    throw err;
  }
  await store.inTransaction(async () => {
    await store.saveSession(address, result.session);
    await store.savePeerIdentityIfNew(address, result.remoteIdentityKey);
    await store.savePeerDevice(peerUserId, bundle.deviceId, bundle.signalDeviceId);
  });
  return { deviceId: bundle.deviceId, signalDeviceId: bundle.signalDeviceId };
}

/**
 * Serialises every Signal session read-modify-write (encrypt, decrypt, session setup).
 * Without it a send and a decrypt could both load the same session record and the second
 * save would silently discard the first ratchet step.
 */
let signalQueue = Promise.resolve();
function withSignalLock(fn) {
  const run = signalQueue.then(fn, fn);
  signalQueue = run.catch(() => {});
  return run;
}

/** Errors worth retrying automatically (offline, timeouts, server/rate-limit trouble). */
function isTemporary(err) {
  return (
    err instanceof NetworkError ||
    (err instanceof ApiError && (err.status >= 500 || err.status === 429))
  );
}

/**
 * Encrypts the stored message and saves the ciphertext in the outbox, in one transaction with
 * the advanced session, so the ciphertext that will be sent is exactly the one the ratchet
 * produced. Runs only when the message has no outbox entry yet.
 */
function encryptToOutbox(myUserId, message, attachment = null) {
  return withSignalLock(async () => {
    const existing = await messages.loadOutbox(message.clientMessageId);
    if (existing) return existing;
    const peerUserId = message.peerUserId;
    // Nothing is encrypted for a peer whose new security code is still undecided.
    if (await store.getPendingIdentityChange(peerUserId)) throw untrustedIdentityError();
    const local = await localContext(myUserId);
    let peer = await store.loadPeerDevice(peerUserId);
    const hasSession =
      peer && (await store.loadSession(store.addressOf(peerUserId, peer.signalDeviceId)));
    if (!hasSession) peer = await establishSession(local, peerUserId);
    const address = store.addressOf(peerUserId, peer.signalDeviceId);

    const encrypted = await getSignalNative().encrypt(
      local,
      {
        name: peerUserId,
        deviceId: peer.signalDeviceId,
        identityKey: await store.loadPeerIdentity(address),
        session: await store.loadSession(address),
      },
      bytesToBase64(
        encodeContent(
          attachment ? contentForAttachment(attachment, message.body) : textContent(message.body),
        ),
      ),
    );
    const entry = {
      clientMessageId: message.clientMessageId,
      recipientUserId: peerUserId,
      recipientDeviceId: peer.deviceId,
      recipientRegistrationId: encrypted.remoteRegistrationId ?? null,
      type: encrypted.type,
      ciphertext: encrypted.body,
    };
    await store.inTransaction(async () => {
      await store.saveSession(address, encrypted.session);
      await messages.saveOutbox(entry);
    });
    return entry;
  });
}

// --- Internal content outside the chat (call-security attestations) ---

/**
 * Encrypts internal content (messaging/content.js bytes) for `peerUserId` on the regular Signal
 * session, for a channel other than chat messages (a call's attestation, sent with its
 * signaling). Same lock and atomic session update as a message; nothing else is stored: no
 * message, outbox entry or conversation. Refused while the peer's new security code is
 * undecided. `fresh` first replaces the session with one built from a new key bundle (the
 * server said the peer registered new keys); a changed identity key is refused there and
 * recorded for the user to review, as for messages.
 *
 * @returns {Promise<{ type: number, body: string, recipientRegistrationId: number | null }>}
 */
export function sealForPeer(myUserId, peerUserId, bytes, { fresh = false } = {}) {
  return withSignalLock(async () => {
    if (await store.getPendingIdentityChange(peerUserId)) throw untrustedIdentityError();
    const local = await localContext(myUserId);
    let peer = await store.loadPeerDevice(peerUserId);
    if (fresh && peer) {
      const stale = store.addressOf(peerUserId, peer.signalDeviceId);
      await store.inTransaction(async () => {
        await store.deleteSession(stale);
        await store.deletePeerDevice(peerUserId);
      });
      peer = null;
    }
    const hasSession =
      peer && (await store.loadSession(store.addressOf(peerUserId, peer.signalDeviceId)));
    if (!hasSession) peer = await establishSession(local, peerUserId);
    const address = store.addressOf(peerUserId, peer.signalDeviceId);
    const encrypted = await getSignalNative().encrypt(
      local,
      {
        name: peerUserId,
        deviceId: peer.signalDeviceId,
        identityKey: await store.loadPeerIdentity(address),
        session: await store.loadSession(address),
      },
      bytesToBase64(bytes),
    );
    await store.saveSession(address, encrypted.session);
    return {
      type: encrypted.type,
      body: encrypted.body,
      recipientRegistrationId: encrypted.remoteRegistrationId ?? null,
    };
  });
}

/**
 * Decrypts internal content `sender.userId` sent outside the chat (a call's attestation) on the
 * Signal session with that person: the session and its trusted identity key decide who it is
 * from. `sender.deviceId` (from the server) is never trusted for that; like an envelope's
 * sender device, it only routes this phone's later messages to the peer. Under the Signal lock,
 * in one transaction: session, peer identity (first contact), peer device, used pre-key. No
 * message, conversation or receipt is created.
 *
 * Throws a coded error: UNTRUSTED_IDENTITY (the peer's identity key changed; recorded for the
 * user to review, nothing decrypted), DUPLICATE_MESSAGE (already decrypted once), or another
 * libsignal failure.
 *
 * @returns {Promise<object>} the decodeContent() result
 */
export function openFromPeer(myUserId, sender, ciphertext) {
  return withSignalLock(async () => {
    const native = getSignalNative();
    const address = store.addressOf(sender.userId, SIGNAL.DEFAULT_DEVICE_ID);
    const keys = {};
    if (ciphertext.type === CIPHERTEXT_TYPE.PREKEY) {
      const info = await native.preKeyMessageInfo(ciphertext.body);
      keys.preKey = info.preKeyId != null ? await store.loadPreKey(info.preKeyId) : null;
      keys.signedPreKeys = await store.loadAllSignedPreKeys();
      keys.kyberPreKeys = await store.loadAllKyberPreKeys();
    }
    let result;
    try {
      result = await native.decrypt(
        await localContext(myUserId),
        {
          name: sender.userId,
          deviceId: SIGNAL.DEFAULT_DEVICE_ID,
          identityKey: await store.loadPeerIdentity(address),
          session: await store.loadSession(address),
        },
        { type: ciphertext.type, body: ciphertext.body, ...keys },
      );
    } catch (err) {
      if (err?.code === UNTRUSTED_IDENTITY && ciphertext.type === CIPHERTEXT_TYPE.PREKEY) {
        const claimed = (await native.preKeyMessageInfo(ciphertext.body)).identityKey;
        const trusted = await store.loadPeerIdentity(address);
        await store.recordIdentityChange(sender.userId, address, trusted, claimed);
      }
      throw err;
    }
    await store.inTransaction(async () => {
      await store.saveSession(address, result.session);
      await store.savePeerIdentityIfNew(address, result.remoteIdentityKey);
      if (deviceIdSchema.safeParse(sender.deviceId).success) {
        await store.savePeerDevice(sender.userId, sender.deviceId, SIGNAL.DEFAULT_DEVICE_ID);
      }
      if (result.usedPreKeyId != null) await store.removePreKey(result.usedPreKeyId);
    });
    return decodeContent(base64ToBytes(result.plaintext));
  });
}

/**
 * Sends (or re-sends) one stored outgoing message. Safe to call any number of times: the
 * outbox ciphertext and clientMessageId stay the same, and the server deduplicates.
 * Concurrent calls for the same message share one attempt.
 */
const deliveries = new Map();
export function deliverOutgoing(myUserId, clientMessageId) {
  if (!deliveries.has(clientMessageId)) {
    deliveries.set(
      clientMessageId,
      attemptDelivery(myUserId, clientMessageId).finally(() => deliveries.delete(clientMessageId)),
    );
  }
  return deliveries.get(clientMessageId);
}

async function attemptDelivery(myUserId, clientMessageId, { retryOnStale = true } = {}) {
  const message = await messages.getMessage(clientMessageId);
  if (!message) throw new Error('Unknown message');
  if (message.serverMessageId) return { clientMessageId, messageId: message.serverMessageId };

  let entry = await messages.loadOutbox(clientMessageId);
  try {
    if (!entry) {
      // Held, like text, while the peer's new security code is undecided (nothing uploaded).
      if (await store.getPendingIdentityChange(message.peerUserId)) throw untrustedIdentityError();
      // A photo, video or voice note goes to storage (encrypted) before its Signal message,
      // which then carries the server's attachment id with the key.
      const attachment = await ensureUploaded(clientMessageId, message.peerUserId);
      entry = await encryptToOutbox(myUserId, message, attachment);
    }
    const result = await apiRequest('POST', ENDPOINTS.MESSAGES.ROOT, {
      body: {
        recipientUserId: entry.recipientUserId,
        recipientDeviceId: entry.recipientDeviceId,
        // Lets the server reject ciphertext for keys the recipient no longer has (re-login).
        ...(entry.recipientRegistrationId != null
          ? { recipientRegistrationId: entry.recipientRegistrationId }
          : {}),
        clientMessageId,
        type: entry.type,
        ciphertext: entry.ciphertext,
      },
    });
    await store.inTransaction(async () => {
      await messages.setOutgoingStatus(clientMessageId, result.status ?? LOCAL_STATUS.SENT, {
        serverMessageId: result.messageId,
      });
      await messages.deleteOutbox(clientMessageId);
    });
    return { clientMessageId, messageId: result.messageId, type: entry.type };
  } catch (err) {
    if (retryOnStale && err instanceof ApiError && err.code === ERROR_CODE.STALE_RECIPIENT_DEVICE) {
      // The server stored nothing. Peer changed device: drop the old session and the stale
      // ciphertext, then encrypt the same message again for the new device.
      const peer = await store.loadPeerDevice(message.peerUserId);
      if (peer) await store.deleteSession(store.addressOf(message.peerUserId, peer.signalDeviceId));
      await store.deletePeerDevice(message.peerUserId);
      await messages.deleteOutbox(clientMessageId);
      return attemptDelivery(myUserId, clientMessageId, { retryOnStale: false });
    }
    await messages.setOutgoingStatus(clientMessageId, LOCAL_STATUS.FAILED, {
      error: isTemporary(err)
        ? 'TEMPORARY'
        : err instanceof MediaError
          ? err.code
          : (err?.code ?? 'ERROR'),
    });
    throw err;
  }
}

/**
 * Encrypts `text` for `peerUserId` and sends only the ciphertext. The message is stored in the
 * SQLCipher database (status `sending`) before anything else, so a crash never loses it.
 */
export async function sendText(myUserId, peerUserId, text) {
  const clientMessageId = await enqueueText(peerUserId, text);
  return deliverOutgoing(myUserId, clientMessageId);
}

/**
 * Stores an outgoing message (status `sending`); returns its clientMessageId. Text that could
 * never be sent (empty, or over the content limits) throws a ContentError and is not stored.
 */
export async function enqueueText(peerUserId, text) {
  encodeContent(textContent(text));
  const clientMessageId = randomUUID();
  const createdAt = Date.now();
  await store.inTransaction(async () => {
    await store.insertMessage({
      clientMessageId,
      peerUserId,
      direction: 'out',
      body: text,
      status: LOCAL_STATUS.SENDING,
      createdAt,
    });
    await messages.ensureConversation(peerUserId, { at: createdAt });
  });
  return clientMessageId;
}

/**
 * Stores an outgoing photo, video or voice note (already encrypted by prepareAttachment) with
 * its message (status `sending`) in one transaction; returns its clientMessageId. The caption is
 * the message body (empty for none).
 */
export async function enqueueAttachment(peerUserId, prepared, caption = '') {
  const body = caption.trim();
  if (body) encodeContent(textContent(body)); // same limits as a text message
  const clientMessageId = randomUUID();
  const createdAt = Date.now();
  let stored = false;
  try {
    await store.inTransaction(async () => {
      await store.insertMessage({
        clientMessageId,
        peerUserId,
        direction: 'out',
        body,
        status: LOCAL_STATUS.SENDING,
        createdAt,
      });
      const messageId = await attachments.messageRowId({ clientMessageId });
      await attachments.insertAttachment(messageId, prepared);
      await messages.ensureConversation(peerUserId, { at: createdAt });
    });
    stored = true;
  } finally {
    settlePrepared(prepared, { stored });
  }
  return clientMessageId;
}

/** Manual retry of a failed message (same clientMessageId, same ciphertext if one exists). */
export function retryMessage(myUserId, clientMessageId) {
  return deliverOutgoing(myUserId, clientMessageId);
}

/**
 * Re-sends interrupted and temporarily failed messages, oldest first. Stops at the first
 * temporary failure (still offline) so the order of messages is preserved.
 */
export async function flushOutbox(myUserId) {
  let sent = 0;
  for (const { clientMessageId } of await messages.listAutoRetryable()) {
    try {
      await deliverOutgoing(myUserId, clientMessageId);
      sent += 1;
    } catch (err) {
      if (isTemporary(err)) break;
    }
  }
  return { sent };
}

/**
 * Decrypts one stored envelope. Session update, used pre-key removal, message insert and
 * envelope status change commit together, so a crash never loses or double-applies a message.
 * Must run under the Signal lock.
 */
async function processEnvelope(local, envelope) {
  const native = getSignalNative();
  const address = store.addressOf(envelope.senderUserId, envelope.senderSignalDeviceId);
  const keys = {};
  if (envelope.type === CIPHERTEXT_TYPE.PREKEY) {
    const info = await native.preKeyMessageInfo(envelope.ciphertext);
    keys.preKey = info.preKeyId != null ? await store.loadPreKey(info.preKeyId) : null;
    keys.signedPreKeys = await store.loadAllSignedPreKeys();
    keys.kyberPreKeys = await store.loadAllKyberPreKeys();
  }

  let result;
  try {
    result = await native.decrypt(
      local,
      {
        name: envelope.senderUserId,
        deviceId: envelope.senderSignalDeviceId,
        identityKey: await store.loadPeerIdentity(address),
        session: await store.loadSession(address),
      },
      { type: envelope.type, body: envelope.ciphertext, ...keys },
    );
  } catch (err) {
    const code = err?.code ?? 'SIGNAL_ERROR';
    if (code === 'DUPLICATE_MESSAGE') {
      await store.markEnvelope(envelope.envelopeId, 'done', code);
      return { ok: false, code };
    }
    if (code === UNTRUSTED_IDENTITY) {
      const held = await holdForIdentityChange(envelope, address);
      if (held) return held;
    }
    // Keep a visible placeholder so the user knows a message arrived but could not be read.
    // The plaintext was never available; nothing is retried with different keys.
    await store.inTransaction(async () => {
      await store.saveIncomingMessage({
        serverMessageId: envelope.messageId,
        peerUserId: envelope.senderUserId,
        body: '',
        status: LOCAL_STATUS.UNDECRYPTABLE,
        error: code,
        createdAt: serverTime(envelope),
      });
      await messages.ensureConversation(envelope.senderUserId, { at: serverTime(envelope) });
      await store.markEnvelope(envelope.envelopeId, 'failed', code);
    });
    return { ok: false, code };
  }

  const incoming = incomingMessage(decodeContent(base64ToBytes(result.plaintext)));
  await store.inTransaction(async () => {
    // The session advanced whatever the content is: always kept, like a used pre-key's removal.
    await store.saveSession(address, result.session);
    await store.savePeerIdentityIfNew(address, result.remoteIdentityKey);
    // Remember the sender's device so replies continue this session (no new bundle fetch).
    await store.savePeerDevice(
      envelope.senderUserId,
      envelope.senderDeviceId,
      envelope.senderSignalDeviceId,
    );
    if (result.usedPreKeyId != null) await store.removePreKey(result.usedPreKeyId);
    if (incoming) {
      const { attachment, ...message } = incoming;
      await store.saveIncomingMessage({
        serverMessageId: envelope.messageId,
        peerUserId: envelope.senderUserId,
        ...message,
        createdAt: serverTime(envelope),
      });
      if (attachment) {
        const messageId = await attachments.messageRowId({ serverMessageId: envelope.messageId });
        await attachments.insertAttachment(messageId, attachment);
      }
      await messages.ensureConversation(envelope.senderUserId, { at: serverTime(envelope) });
    } else {
      // Internal content: no message, conversation, unread count or read receipt. If it was
      // held for a security-code change, its placeholder goes too.
      await store.deleteHeldMessage(envelope.messageId);
    }
    await store.markEnvelope(envelope.envelopeId, 'done', incoming ? null : INTERNAL_CONTENT);
  });
  return incoming ? { ok: true } : { ok: false, code: INTERNAL_CONTENT };
}

/**
 * What a decrypted message shows in the chat (see messaging/content.js), or null for internal
 * content such as a call-security attestation, which never becomes a chat message wherever it
 * came from. Text, versioned or from an app version before R1, is shown as text; a photo, video
 * or voice note becomes a message (its caption) with an attachment row. Content this version
 * cannot show (an unknown type or version, a file type it cannot display) and malformed content
 * become a placeholder; nothing of that content is kept.
 */
function incomingMessage(decoded) {
  if (decoded.internal) return null;
  if (decoded.ok && decoded.content.type === CONTENT_TYPE.TEXT) {
    return { body: decoded.content.text, status: LOCAL_STATUS.RECEIVED };
  }
  if (decoded.ok && decoded.content.type === CONTENT_TYPE.ATTACHMENT) {
    // The key and digest go to the attachment row; the blob is fetched after this transaction.
    const attachment = incomingAttachmentFields(decoded.content);
    if (attachment) {
      return { body: decoded.content.caption ?? '', status: LOCAL_STATUS.RECEIVED, attachment };
    }
  }
  const malformed = !decoded.ok && decoded.reason === 'invalid';
  return {
    body: '',
    status: LOCAL_STATUS.UNSUPPORTED,
    error: malformed ? INVALID_CONTENT : UNSUPPORTED_CONTENT,
  };
}

/**
 * libsignal refused an incoming message because the sender's identity key differs from the
 * trusted one. Nothing is decrypted and nothing is trusted: the ciphertext stays in the local
 * inbox (status `identity_pending`), the change is recorded for the user to review, and a
 * placeholder shows that a message is waiting. No read receipt can be sent for it (it is never
 * `received`). Returns null if the new key cannot be determined (then the message is handled
 * as undecryptable, as before). Must run under the Signal lock.
 */
async function holdForIdentityChange(envelope, address) {
  const claimed =
    envelope.type === CIPHERTEXT_TYPE.PREKEY
      ? (await getSignalNative().preKeyMessageInfo(envelope.ciphertext)).identityKey
      : null;
  const trusted = await store.loadPeerIdentity(address);
  if (!claimed || !trusted || claimed === trusted) return null;
  await store.inTransaction(async () => {
    await store.recordIdentityChange(envelope.senderUserId, address, trusted, claimed, {
      at: serverTime(envelope),
    });
    await store.insertMessage({
      serverMessageId: envelope.messageId,
      peerUserId: envelope.senderUserId,
      direction: 'in',
      body: '',
      status: LOCAL_STATUS.IDENTITY_PENDING,
      error: UNTRUSTED_IDENTITY,
      createdAt: serverTime(envelope),
    });
    await messages.ensureConversation(envelope.senderUserId, { at: serverTime(envelope) });
    await store.markEnvelope(envelope.envelopeId, 'identity_pending', UNTRUSTED_IDENTITY);
  });
  return { ok: false, code: UNTRUSTED_IDENTITY };
}

/** Server timestamp of an envelope (consistent ordering across devices), else local time. */
function serverTime(envelope) {
  return Date.parse(envelope.createdAt) || Date.now();
}

async function processPendingEnvelopes(myUserId) {
  return withSignalLock(async () => {
    const local = await localContext(myUserId);
    const results = [];
    for (const envelope of await store.loadPendingEnvelopes()) {
      results.push(await processEnvelope(local, envelope));
    }
    return results;
  });
}

async function runSyncInbox(myUserId) {
  // Envelopes already stored locally (realtime, or before a crash) are shown first.
  const results = await processPendingEnvelopes(myUserId);

  // Then everything the server still holds for this device, page by page.
  for (;;) {
    const after = Number(await store.getSyncValue(ENVELOPE_CURSOR)) || 0;
    // The server's default page size is LIMITS.PAGE_SIZE_DEFAULT.
    const { envelopes } = await apiRequest('GET', ENDPOINTS.MESSAGES.envelopes(after));
    if (envelopes.length === 0) break;

    let maxSeq = after;
    for (const envelope of envelopes) {
      await store.insertEnvelopeIfNew(envelope);
      maxSeq = Math.max(maxSeq, envelope.seq);
    }
    results.push(...(await processPendingEnvelopes(myUserId)));

    // Acknowledge only after the envelopes are stored and processed locally.
    await apiRequest('POST', ENDPOINTS.MESSAGES.ENVELOPES_ACK, { body: { upToSeq: maxSeq } });
    await store.setSyncValue(ENVELOPE_CURSOR, maxSeq);
    if (envelopes.length < LIMITS.PAGE_SIZE_DEFAULT) break;
  }

  return {
    received: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

/**
 * Pulls new envelopes from the server (durable source of truth), stores them, decrypts them,
 * then acknowledges. Safe to call repeatedly (after restart, reconnect or a realtime event);
 * concurrent calls share one run.
 */
let inboxSyncInFlight = null;
export function syncInbox(myUserId) {
  inboxSyncInFlight ??= runSyncInbox(myUserId).finally(() => {
    inboxSyncInFlight = null;
  });
  return inboxSyncInFlight;
}

/**
 * Handles a realtime `envelope` event. Inline envelopes are stored (crash-safe) and decrypted
 * straight away; id-only events (large envelopes) are fetched over HTTPS by the sync.
 * Duplicate events are harmless: envelopes and messages are deduplicated by id.
 */
export async function handleRealtimeEnvelope(myUserId, payload) {
  if (payload?.inline && payload.envelope) {
    await store.insertEnvelopeIfNew({
      envelopeId: payload.envelopeId,
      seq: payload.seq,
      ...payload.envelope,
    });
    await processPendingEnvelopes(myUserId);
  }
  // A run already in flight may have fetched before this envelope existed: wait for it, then
  // sync again so the new envelope is acknowledged.
  if (inboxSyncInFlight) await inboxSyncInFlight.catch(() => {});
  return syncInbox(myUserId);
}

// --- Security code (identity verification) ---

/** The undecided identity change for a peer (`{ id, newIdentityKey, ... }`) or null. */
export const getPendingIdentityChange = store.getPendingIdentityChange;
export const listIdentityChanges = store.listIdentityChanges;

/**
 * The security code (Signal safety number, 60 digits) for this user and a peer, computed by
 * libsignal from both identity public keys. While a change is pending it is the code for the
 * peer's NEW key (the one the user is asked to accept). Null if the peer's key is not known yet.
 *
 * @returns {Promise<{ code: string, identityKey: string, pending: boolean } | null>}
 */
export async function getSecurityCode(myUserId, peerUserId) {
  const pending = await store.getPendingIdentityChange(peerUserId);
  const peer = await store.loadPeerDevice(peerUserId);
  const peerKey =
    pending?.newIdentityKey ??
    (await store.loadPeerIdentity(
      store.addressOf(peerUserId, peer?.signalDeviceId ?? SIGNAL.DEFAULT_DEVICE_ID),
    ));
  const identity = await store.loadIdentity();
  if (!peerKey || !identity) return null;
  const code = await getSignalNative().securityCode(
    SIGNAL.SECURITY_CODE_ITERATIONS,
    SIGNAL.SECURITY_CODE_VERSION,
    myUserId,
    identity.identityKey,
    peerUserId,
    peerKey,
  );
  return { code, identityKey: peerKey, pending: Boolean(pending) };
}

/**
 * The user explicitly accepted a peer's new security code. `expectedIdentityKey` is the key
 * whose code the user was shown: if the pending key changed in the meantime nothing happens.
 *
 * In one transaction: the new key becomes the trusted key, the old session (built for the
 * old key) and the cached device are dropped, unsent ciphertext for the old session is
 * discarded, and held incoming envelopes are queued again. Then the held envelopes are
 * decrypted (libsignal builds the new session from the peer's PreKeySignalMessage) and held
 * outgoing messages are encrypted and sent (with a fresh bundle if no session exists).
 * Idempotent: a second call finds no pending change and returns false.
 */
export async function acceptIdentityChange(myUserId, peerUserId, expectedIdentityKey) {
  const accepted = await withSignalLock(async () => {
    const change = await store.getPendingIdentityChange(peerUserId);
    if (!change || change.newIdentityKey !== expectedIdentityKey) return false;
    await store.inTransaction(async () => {
      await store.replacePeerIdentity(change.address, change.newIdentityKey);
      await store.deleteSession(change.address);
      await store.deletePeerDevice(peerUserId);
      await messages.deleteOutboxFor(peerUserId);
      await store.markIdentityChangeAccepted(change.id);
      await store.requeueIdentityPendingEnvelopes(peerUserId);
    });
    return true;
  });
  if (!accepted) return false;

  await processPendingEnvelopes(myUserId);
  for (const clientMessageId of await messages.listHeldForIdentity(peerUserId)) {
    try {
      await deliverOutgoing(myUserId, clientMessageId);
    } catch {
      // Stays failed (shown in the chat); temporary failures are retried by the next sync.
    }
  }
  return true;
}

export const listConversation = store.listMessages;
