import { SIGNAL } from '@secure-chat/shared/constants';

import { getDatabase } from '../db/database';
import { deleteSecureItem, getSecureJson, SECURE_KEYS, setSecureJson } from '../lib/secureStorage';

/**
 * Persistence for Signal Protocol state.
 *  - Identity key pair (long-term private key): SecureStore (Keychain / Android Keystore).
 *  - Pre-keys, sessions, peer identities, envelopes: SQLCipher database (key in SecureStore).
 * Nothing here is ever sent to the server; the public halves are uploaded separately.
 */

export const addressOf = (userId, deviceId = SIGNAL.DEFAULT_DEVICE_ID) => `${userId}.${deviceId}`;

// --- Identity (SecureStore) ---

/** @returns {Promise<{ identityKeyPair: string, identityKey: string, registrationId: number } | null>} */
export async function loadIdentity() {
  return getSecureJson(SECURE_KEYS.SIGNAL_IDENTITY);
}

export async function saveIdentity(identity) {
  await setSecureJson(SECURE_KEYS.SIGNAL_IDENTITY, identity);
}

export async function deleteIdentity() {
  await deleteSecureItem(SECURE_KEYS.SIGNAL_IDENTITY);
}

// --- Own pre-keys ---

const now = () => Date.now();

export async function saveSignedPreKey({ keyId, record }) {
  await getDatabase().runAsync(
    'INSERT OR REPLACE INTO signal_signed_prekeys (key_id, record, created_at) VALUES (?, ?, ?);',
    keyId,
    record,
    now(),
  );
}

export async function saveKyberPreKey({ keyId, record }) {
  await getDatabase().runAsync(
    'INSERT OR REPLACE INTO signal_kyber_prekeys (key_id, record, created_at) VALUES (?, ?, ?);',
    keyId,
    record,
    now(),
  );
}

export async function savePreKeys(preKeys) {
  const db = getDatabase();
  await db.withTransactionAsync(async () => {
    for (const { keyId, record } of preKeys) {
      await db.runAsync(
        'INSERT OR REPLACE INTO signal_prekeys (key_id, record, created_at) VALUES (?, ?, ?);',
        keyId,
        record,
        now(),
      );
    }
  });
}

export async function loadPreKey(keyId) {
  const row = await getDatabase().getFirstAsync(
    'SELECT record FROM signal_prekeys WHERE key_id = ?;',
    keyId,
  );
  return row?.record ?? null;
}

export async function removePreKey(keyId) {
  await getDatabase().runAsync('DELETE FROM signal_prekeys WHERE key_id = ?;', keyId);
}

export async function loadAllSignedPreKeys() {
  const rows = await getDatabase().getAllAsync(
    'SELECT record FROM signal_signed_prekeys ORDER BY created_at DESC;',
  );
  return rows.map((r) => r.record);
}

export async function loadAllKyberPreKeys() {
  const rows = await getDatabase().getAllAsync(
    'SELECT record FROM signal_kyber_prekeys ORDER BY created_at DESC;',
  );
  return rows.map((r) => r.record);
}

export async function countLocalPreKeys() {
  const row = await getDatabase().getFirstAsync('SELECT count(*) AS n FROM signal_prekeys;');
  return row?.n ?? 0;
}

// --- Sessions and peer identities ---

export async function loadSession(address) {
  const row = await getDatabase().getFirstAsync(
    'SELECT record FROM signal_sessions WHERE address = ?;',
    address,
  );
  return row?.record ?? null;
}

export async function saveSession(address, record) {
  await getDatabase().runAsync(
    'INSERT OR REPLACE INTO signal_sessions (address, record, updated_at) VALUES (?, ?, ?);',
    address,
    record,
    now(),
  );
}

export async function deleteSession(address) {
  await getDatabase().runAsync('DELETE FROM signal_sessions WHERE address = ?;', address);
}

export async function loadPeerIdentity(address) {
  const row = await getDatabase().getFirstAsync(
    'SELECT identity_key FROM signal_identities WHERE address = ?;',
    address,
  );
  return row?.identity_key ?? null;
}

/** Trust on first use: records the first identity seen; never silently overwrites it. */
export async function savePeerIdentityIfNew(address, identityKey) {
  if (!identityKey) return;
  await getDatabase().runAsync(
    'INSERT OR IGNORE INTO signal_identities (address, identity_key, first_seen_at) VALUES (?, ?, ?);',
    address,
    identityKey,
    now(),
  );
}

// --- Identity changes ("security code changed") ---

/** The undecided identity change for a peer, or null. */
export async function getPendingIdentityChange(peerUserId) {
  return getDatabase().getFirstAsync(
    `SELECT id, peer_user_id AS peerUserId, address, previous_identity_key AS previousIdentityKey,
            new_identity_key AS newIdentityKey, detected_at AS detectedAt
       FROM identity_changes WHERE peer_user_id = ? AND status = 'pending';`,
    peerUserId,
  );
}

/**
 * Records that a peer presented `newIdentityKey` while `trustedIdentityKey` is trusted. The
 * trusted key is NOT touched. If a change is already pending, it now refers to the latest key.
 * `at` is when the change happened (for an incoming message: its server time), so the chat
 * shows the notice before the first message with the new key.
 */
export async function recordIdentityChange(
  peerUserId,
  address,
  trustedIdentityKey,
  newIdentityKey,
  { at = now() } = {},
) {
  if (!newIdentityKey || !trustedIdentityKey || newIdentityKey === trustedIdentityKey) return;
  const db = getDatabase();
  const pending = await getPendingIdentityChange(peerUserId);
  if (pending) {
    if (pending.newIdentityKey === newIdentityKey) return;
    await db.runAsync(
      'UPDATE identity_changes SET new_identity_key = ?, address = ?, detected_at = ? WHERE id = ?;',
      newIdentityKey,
      address,
      at,
      pending.id,
    );
    return;
  }
  await db.runAsync(
    `INSERT INTO identity_changes
       (peer_user_id, address, previous_identity_key, new_identity_key, status, detected_at)
     VALUES (?, ?, ?, ?, 'pending', ?);`,
    peerUserId,
    address,
    trustedIdentityKey,
    newIdentityKey,
    at,
  );
}

/** Makes `identityKey` the trusted key for `address` (only after the user accepted it). */
export async function replacePeerIdentity(address, identityKey) {
  await getDatabase().runAsync(
    'INSERT OR REPLACE INTO signal_identities (address, identity_key, first_seen_at) VALUES (?, ?, ?);',
    address,
    identityKey,
    now(),
  );
}

export async function markIdentityChangeAccepted(id) {
  await getDatabase().runAsync(
    "UPDATE identity_changes SET status = 'accepted', resolved_at = ? WHERE id = ?;",
    now(),
    id,
  );
}

/** Identity-change events of one conversation (timeline notices), oldest first. */
export async function listIdentityChanges(peerUserId) {
  return getDatabase().getAllAsync(
    `SELECT id, status, detected_at AS detectedAt, resolved_at AS resolvedAt
       FROM identity_changes WHERE peer_user_id = ? ORDER BY detected_at ASC;`,
    peerUserId,
  );
}

/** Puts a peer's held envelopes back in the inbox queue (after their new key was accepted). */
export async function requeueIdentityPendingEnvelopes(senderUserId) {
  const result = await getDatabase().runAsync(
    `UPDATE message_envelopes SET status = 'pending', error = NULL
      WHERE sender_user_id = ? AND status = 'identity_pending';`,
    senderUserId,
  );
  return result.changes;
}

export async function loadPeerDevice(userId) {
  return getDatabase().getFirstAsync(
    'SELECT device_id AS deviceId, signal_device_id AS signalDeviceId FROM peer_devices WHERE user_id = ?;',
    userId,
  );
}

export async function savePeerDevice(userId, deviceId, signalDeviceId) {
  await getDatabase().runAsync(
    'INSERT OR REPLACE INTO peer_devices (user_id, device_id, signal_device_id, updated_at) VALUES (?, ?, ?, ?);',
    userId,
    deviceId,
    signalDeviceId,
    now(),
  );
}

export async function deletePeerDevice(userId) {
  await getDatabase().runAsync('DELETE FROM peer_devices WHERE user_id = ?;', userId);
}

// --- Inbox envelopes, local messages, sync state ---

export async function insertEnvelopeIfNew(envelope) {
  const result = await getDatabase().runAsync(
    `INSERT OR IGNORE INTO message_envelopes
       (envelope_id, seq, message_id, sender_user_id, sender_device_id, sender_signal_device_id,
        type, ciphertext, server_created_at, received_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending');`,
    envelope.envelopeId,
    envelope.seq,
    envelope.messageId,
    envelope.senderUserId,
    envelope.senderDeviceId,
    envelope.senderSignalDeviceId,
    envelope.type,
    envelope.ciphertext,
    envelope.createdAt ? String(envelope.createdAt) : null,
    now(),
  );
  return result.changes > 0;
}

export async function loadPendingEnvelopes() {
  return getDatabase().getAllAsync(
    `SELECT envelope_id AS envelopeId, seq, message_id AS messageId, sender_user_id AS senderUserId,
            sender_device_id AS senderDeviceId, sender_signal_device_id AS senderSignalDeviceId,
            type, ciphertext, server_created_at AS createdAt
       FROM message_envelopes WHERE status = 'pending' ORDER BY seq ASC;`,
  );
}

/**
 * Processed envelopes keep their row (so a re-delivered copy is recognised as a duplicate)
 * but drop the ciphertext, which is no longer needed.
 */
export async function markEnvelope(envelopeId, status, error = null) {
  await getDatabase().runAsync(
    `UPDATE message_envelopes SET status = ?, error = ?,
            ciphertext = CASE WHEN ? = 'done' THEN '' ELSE ciphertext END
      WHERE envelope_id = ?;`,
    status,
    error,
    status,
    envelopeId,
  );
}

export async function insertMessage(message) {
  await getDatabase().runAsync(
    `INSERT OR IGNORE INTO messages
       (client_message_id, server_message_id, peer_user_id, direction, body, status, error,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    message.clientMessageId ?? null,
    message.serverMessageId ?? null,
    message.peerUserId,
    message.direction,
    message.body,
    message.status,
    message.error ?? null,
    message.createdAt ?? now(),
  );
}

/**
 * Stores a decrypted incoming message. If the message was held as an `identity_pending`
 * placeholder (sender's security code changed), that same row becomes the message: no
 * duplicate, same position in the chat. Any other existing row is left untouched.
 */
export async function saveIncomingMessage(message) {
  await getDatabase().runAsync(
    `INSERT INTO messages
       (server_message_id, peer_user_id, direction, body, status, error, created_at)
       VALUES (?, ?, 'in', ?, ?, ?, ?)
     ON CONFLICT(server_message_id) DO UPDATE SET
       body = excluded.body, status = excluded.status, error = excluded.error
     WHERE messages.status = 'identity_pending';`,
    message.serverMessageId,
    message.peerUserId,
    message.body,
    message.status,
    message.error ?? null,
    message.createdAt ?? now(),
  );
}

export async function listMessages(peerUserId, limit = 50) {
  return getDatabase().getAllAsync(
    `SELECT id, peer_user_id AS peerUserId, direction, body, status, created_at AS createdAt
       FROM messages WHERE peer_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?;`,
    peerUserId,
    limit,
  );
}

export async function listRecentMessages(limit = 10) {
  return getDatabase().getAllAsync(
    `SELECT id, peer_user_id AS peerUserId, direction, body, status, created_at AS createdAt
       FROM messages ORDER BY created_at DESC, id DESC LIMIT ?;`,
    limit,
  );
}

export async function getSyncValue(key) {
  const row = await getDatabase().getFirstAsync('SELECT value FROM sync_state WHERE key = ?;', key);
  return row?.value ?? null;
}

export async function setSyncValue(key, value) {
  await getDatabase().runAsync(
    'INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?);',
    key,
    String(value),
  );
}

/** Runs `fn` inside one SQLite transaction (all-or-nothing on crash). */
export async function inTransaction(fn) {
  await getDatabase().withTransactionAsync(fn);
}
