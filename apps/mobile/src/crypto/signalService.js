import { CIPHERTEXT_TYPE, ERROR_CODE, LIMITS, SIGNAL } from '@secure-chat/shared/constants';
import { randomUUID } from 'expo-crypto';

import { getSignalNative } from '../../modules/signal-protocol';
import { ApiError, apiRequest, NetworkError } from '../lib/api';
import * as messages from '../messaging/messageStore';
import { LOCAL_STATUS } from '../messaging/messageStore';
import { base64ToUtf8, utf8ToBase64 } from './encoding';
import * as store from './signalStore';

/**
 * E2EE foundation (Phase 3A). All cryptography is done by the official libsignal through the
 * native module; this file only orchestrates calls and persistence. The server receives public
 * keys and ciphertext, never private keys or plaintext.
 */

const NEXT_PREKEY_ID = 'next_prekey_id';
const ENVELOPE_CURSOR = 'envelope_cursor';

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
  const { status } = await apiRequest('GET', '/keys/status');

  if (!status.registered) {
    const native = getSignalNative();
    const signed = await native.generateSignedPreKey(identity.identityKeyPair, randomKeyId());
    const kyber = await native.generateKyberPreKey(identity.identityKeyPair, randomKeyId());
    await store.saveSignedPreKey(signed);
    await store.saveKyberPreKey(kyber);
    const oneTimePreKeys = await generateOneTimePreKeys(SIGNAL.ONE_TIME_PREKEY_BATCH);

    const result = await apiRequest('PUT', '/keys', {
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

  if (status.oneTimePreKeyCount < SIGNAL.ONE_TIME_PREKEY_LOW_WATERMARK) {
    const preKeys = await generateOneTimePreKeys(SIGNAL.ONE_TIME_PREKEY_BATCH);
    return (await apiRequest('POST', '/keys/one-time', { body: { preKeys } })).status;
  }
  return status;
}

function pickPublic({ keyId, publicKey, signature }) {
  return { keyId, publicKey, signature };
}

/** Starts a session with a peer from their public pre-key bundle (PQXDH via libsignal). */
async function establishSession(local, peerUserId) {
  const { bundle } = await apiRequest('GET', `/keys/bundle/${peerUserId}`);
  const address = store.addressOf(peerUserId, bundle.signalDeviceId);
  const result = await getSignalNative().processPreKeyBundle(
    local,
    {
      name: peerUserId,
      deviceId: bundle.signalDeviceId,
      identityKey: await store.loadPeerIdentity(address),
    },
    bundle,
  );
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
function encryptToOutbox(myUserId, message) {
  return withSignalLock(async () => {
    const existing = await messages.loadOutbox(message.clientMessageId);
    if (existing) return existing;
    const local = await localContext(myUserId);
    const peerUserId = message.peerUserId;
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
      utf8ToBase64(message.body),
    );
    const entry = {
      clientMessageId: message.clientMessageId,
      recipientUserId: peerUserId,
      recipientDeviceId: peer.deviceId,
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
    entry ??= await encryptToOutbox(myUserId, message);
    const result = await apiRequest('POST', '/messages', {
      body: {
        recipientUserId: entry.recipientUserId,
        recipientDeviceId: entry.recipientDeviceId,
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
      error: isTemporary(err) ? 'TEMPORARY' : (err?.code ?? 'ERROR'),
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

/** Stores an outgoing message (status `sending`); returns its clientMessageId. */
export async function enqueueText(peerUserId, text) {
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
    // Keep a visible placeholder so the user knows a message arrived but could not be read.
    // The plaintext was never available; nothing is retried with different keys.
    await store.inTransaction(async () => {
      await store.insertMessage({
        serverMessageId: envelope.messageId,
        peerUserId: envelope.senderUserId,
        direction: 'in',
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

  await store.inTransaction(async () => {
    await store.saveSession(address, result.session);
    await store.savePeerIdentityIfNew(address, result.remoteIdentityKey);
    // Remember the sender's device so replies continue this session (no new bundle fetch).
    await store.savePeerDevice(
      envelope.senderUserId,
      envelope.senderDeviceId,
      envelope.senderSignalDeviceId,
    );
    if (result.usedPreKeyId != null) await store.removePreKey(result.usedPreKeyId);
    await store.insertMessage({
      serverMessageId: envelope.messageId,
      peerUserId: envelope.senderUserId,
      direction: 'in',
      body: base64ToUtf8(result.plaintext),
      status: LOCAL_STATUS.RECEIVED,
      createdAt: serverTime(envelope),
    });
    await messages.ensureConversation(envelope.senderUserId, { at: serverTime(envelope) });
    await store.markEnvelope(envelope.envelopeId, 'done');
  });
  return { ok: true };
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
    const { envelopes } = await apiRequest('GET', `/messages/envelopes?after=${after}`);
    if (envelopes.length === 0) break;

    let maxSeq = after;
    for (const envelope of envelopes) {
      await store.insertEnvelopeIfNew(envelope);
      maxSeq = Math.max(maxSeq, envelope.seq);
    }
    results.push(...(await processPendingEnvelopes(myUserId)));

    // Acknowledge only after the envelopes are stored and processed locally.
    await apiRequest('POST', '/messages/envelopes/ack', { body: { upToSeq: maxSeq } });
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

export const listConversation = store.listMessages;
