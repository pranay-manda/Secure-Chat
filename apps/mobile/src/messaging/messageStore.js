import { getDatabase } from '../db/database';

/**
 * Local (SQLCipher) persistence for conversations, message state and the outbox.
 * Plaintext message bodies live only in this encrypted database on the device.
 */

const now = () => Date.now();

/** Local message states. Order matters for outgoing messages: a state never goes backwards. */
export const LOCAL_STATUS = Object.freeze({
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
  RECEIVED: 'received',
  UNDECRYPTABLE: 'undecryptable',
});

const OUTGOING_RANK = { sending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };

// --- Conversations ---

export async function ensureConversation(peerUserId, { title = null, at = null } = {}) {
  await getDatabase().runAsync(
    `INSERT INTO conversations (peer_user_id, title, created_at, last_message_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_user_id) DO UPDATE SET
       title = COALESCE(excluded.title, conversations.title),
       last_message_at = MAX(COALESCE(conversations.last_message_at, 0),
                             COALESCE(excluded.last_message_at, 0));`,
    peerUserId,
    title,
    now(),
    at,
  );
}

export async function getConversation(peerUserId) {
  return getDatabase().getFirstAsync(
    `SELECT peer_user_id AS peerUserId, title, created_at AS createdAt,
            last_message_at AS lastMessageAt
       FROM conversations WHERE peer_user_id = ?;`,
    peerUserId,
  );
}

/** Conversation list with the latest message and unread count, most recent first. */
export async function listConversations() {
  return getDatabase().getAllAsync(
    `SELECT c.peer_user_id AS peerUserId, c.title,
            COALESCE(c.last_message_at, c.created_at) AS sortAt,
            last.body AS lastBody, last.direction AS lastDirection, last.status AS lastStatus,
            (SELECT count(*) FROM messages u
               WHERE u.peer_user_id = c.peer_user_id AND u.direction = 'in'
                 AND u.status = 'received') AS unread
       FROM conversations c
       LEFT JOIN messages last ON last.id = (
         SELECT m.id FROM messages m WHERE m.peer_user_id = c.peer_user_id
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
      ORDER BY sortAt DESC;`,
  );
}

// --- Messages ---

export async function getMessage(clientMessageId) {
  return getDatabase().getFirstAsync(
    `SELECT client_message_id AS clientMessageId, server_message_id AS serverMessageId,
            peer_user_id AS peerUserId, body, status, error
       FROM messages WHERE client_message_id = ?;`,
    clientMessageId,
  );
}

/** Peer of a message, found locally from its opaque server id (notification tap routing). */
export async function findPeerByServerMessageId(serverMessageId) {
  const row = await getDatabase().getFirstAsync(
    'SELECT peer_user_id AS peerUserId FROM messages WHERE server_message_id = ?;',
    serverMessageId,
  );
  return row?.peerUserId ?? null;
}

/** Messages of one conversation, newest first (what the chat screen renders). */
export async function listChatMessages(peerUserId, limit = 200) {
  return getDatabase().getAllAsync(
    `SELECT id, client_message_id AS clientMessageId, server_message_id AS serverMessageId,
            direction, body, status, error, created_at AS createdAt
       FROM messages WHERE peer_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?;`,
    peerUserId,
    limit,
  );
}

export async function setOutgoingStatus(clientMessageId, status, { serverMessageId, error } = {}) {
  await getDatabase().runAsync(
    `UPDATE messages SET status = ?, error = ?,
            server_message_id = COALESCE(?, server_message_id)
      WHERE client_message_id = ?;`,
    status,
    error ?? null,
    serverMessageId ?? null,
    clientMessageId,
  );
}

/**
 * Outgoing messages that should be (re)sent automatically: interrupted sends (app killed while
 * sending) and sends that failed for a temporary reason. Permanent failures wait for a tap.
 */
export async function listAutoRetryable() {
  return getDatabase().getAllAsync(
    `SELECT client_message_id AS clientMessageId FROM messages
      WHERE direction = 'out' AND (status = 'sending' OR (status = 'failed' AND error = 'TEMPORARY'))
      ORDER BY created_at ASC, id ASC;`,
  );
}

/** Applies delivered/read receipts to outgoing messages; never moves a state backwards. */
export async function applyReceipts(receipts) {
  const db = getDatabase();
  let changed = 0;
  for (const { messageId, status, at } of receipts) {
    const row = await db.getFirstAsync(
      `SELECT status FROM messages WHERE server_message_id = ? AND direction = 'out';`,
      messageId,
    );
    if (!row || (OUTGOING_RANK[status] ?? -1) <= (OUTGOING_RANK[row.status] ?? 0)) continue;
    const time = Date.parse(at) || now();
    await db.runAsync(
      `UPDATE messages SET status = ?,
              delivered_at = COALESCE(delivered_at, ?),
              read_at = CASE WHEN ? = 'read' THEN COALESCE(read_at, ?) ELSE read_at END
        WHERE server_message_id = ?;`,
      status,
      time,
      status,
      time,
      messageId,
    );
    changed += 1;
  }
  return changed;
}

/** Server ids of outgoing messages whose final state (read) is not known yet. */
export async function listUnsettledOutgoing(limit) {
  const rows = await getDatabase().getAllAsync(
    `SELECT server_message_id AS id FROM messages
      WHERE direction = 'out' AND status IN ('sent', 'delivered') AND server_message_id IS NOT NULL
      ORDER BY created_at DESC LIMIT ?;`,
    limit,
  );
  return rows.map((r) => r.id);
}

/** Marks a conversation's received messages as read and queues their read receipts. */
export async function markIncomingRead(peerUserId) {
  const result = await getDatabase().runAsync(
    `UPDATE messages SET status = 'read', read_at = ?, receipt_pending = 1
      WHERE peer_user_id = ? AND direction = 'in' AND status = 'received';`,
    now(),
    peerUserId,
  );
  return result.changes;
}

export async function listPendingReadReceipts(limit) {
  const rows = await getDatabase().getAllAsync(
    `SELECT server_message_id AS id FROM messages
      WHERE receipt_pending = 1 AND server_message_id IS NOT NULL LIMIT ?;`,
    limit,
  );
  return rows.map((r) => r.id);
}

export async function clearPendingReadReceipts(serverMessageIds) {
  const db = getDatabase();
  await db.withTransactionAsync(async () => {
    for (const id of serverMessageIds) {
      await db.runAsync('UPDATE messages SET receipt_pending = 0 WHERE server_message_id = ?;', id);
    }
  });
}

// --- Outbox (ciphertext awaiting server acceptance) ---

export async function loadOutbox(clientMessageId) {
  return getDatabase().getFirstAsync(
    `SELECT client_message_id AS clientMessageId, recipient_user_id AS recipientUserId,
            recipient_device_id AS recipientDeviceId, type, ciphertext
       FROM outbox WHERE client_message_id = ?;`,
    clientMessageId,
  );
}

export async function saveOutbox(entry) {
  await getDatabase().runAsync(
    `INSERT OR REPLACE INTO outbox
       (client_message_id, recipient_user_id, recipient_device_id, type, ciphertext, created_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
    entry.clientMessageId,
    entry.recipientUserId,
    entry.recipientDeviceId,
    entry.type,
    entry.ciphertext,
    now(),
  );
}

export async function deleteOutbox(clientMessageId) {
  await getDatabase().runAsync('DELETE FROM outbox WHERE client_message_id = ?;', clientMessageId);
}
