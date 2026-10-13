import { getDatabase } from '../db/database';

/**
 * Local (SQLCipher) rows of attachments: one per message, keyed by the local message row id.
 * The media key and digest are only ever stored here, inside the encrypted database.
 */

export const ATTACHMENT_STATE = Object.freeze({
  /** Outgoing: encrypted blob stored locally, not (completely) uploaded yet. */
  ENCRYPTED: 'encrypted',
  /** Outgoing: the server holds the complete blob. */
  UPLOADED: 'uploaded',
  /** Incoming: not downloaded yet (error TEMPORARY after a retryable failure). */
  PENDING: 'pending',
  /** Incoming: verified encrypted blob stored locally. */
  DOWNLOADED: 'downloaded',
  /** Incoming: gave up (error EXPIRED / CORRUPT / FAILED); a tap retries. */
  FAILED: 'failed',
});

const COLUMNS = `a.message_id AS messageId, a.direction, a.kind, a.voice_note AS voiceNote,
  a.content_type AS contentType, a.attachment_id AS attachmentId,
  a.client_attachment_id AS clientAttachmentId, a.media_key AS mediaKey, a.digest, a.size,
  a.width, a.height, a.duration_ms AS durationMs, a.waveform, a.file_name AS fileName, a.state,
  a.error`;

const now = () => Date.now();

/** Inserts the attachment of message row `messageId` (no-op if it already has one). */
export async function insertAttachment(messageId, a) {
  await getDatabase().runAsync(
    `INSERT OR IGNORE INTO attachments
       (message_id, direction, kind, voice_note, content_type, attachment_id,
        client_attachment_id, media_key, digest, size, width, height, duration_ms, waveform,
        file_name, state, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?);`,
    messageId,
    a.direction,
    a.kind,
    a.voiceNote ? 1 : 0,
    a.contentType,
    a.attachmentId ?? null,
    a.clientAttachmentId ?? null,
    a.mediaKey,
    a.digest,
    a.size,
    a.width ?? null,
    a.height ?? null,
    a.durationMs ?? null,
    a.waveform ?? null,
    a.fileName ?? null,
    a.state,
    now(),
  );
}

export async function getAttachment(messageId) {
  return getDatabase().getFirstAsync(
    `SELECT ${COLUMNS} FROM attachments a WHERE a.message_id = ?;`,
    messageId,
  );
}

/** The attachment of an outgoing message, by its client message id (null for text). */
export async function getOutgoingAttachment(clientMessageId) {
  return getDatabase().getFirstAsync(
    `SELECT ${COLUMNS} FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.client_message_id = ?;`,
    clientMessageId,
  );
}

/** Local row id of a message (by client or server id). */
export async function messageRowId({ clientMessageId, serverMessageId }) {
  const row = clientMessageId
    ? await getDatabase().getFirstAsync(
        'SELECT id FROM messages WHERE client_message_id = ?;',
        clientMessageId,
      )
    : await getDatabase().getFirstAsync(
        'SELECT id FROM messages WHERE server_message_id = ?;',
        serverMessageId,
      );
  return row?.id ?? null;
}

export async function updateAttachment(messageId, changes) {
  const fields = {
    state: changes.state,
    error: changes.error,
    attachment_id: changes.attachmentId,
    file_name: changes.fileName,
  };
  const set = Object.entries(fields).filter(([, value]) => value !== undefined);
  await getDatabase().runAsync(
    `UPDATE attachments SET ${set.map(([column]) => `${column} = ?`).join(', ')},
            updated_at = ?
      WHERE message_id = ?;`,
    ...set.map(([, value]) => value),
    now(),
    messageId,
  );
}

/** Incoming attachments to fetch automatically: never tried, or failed for a temporary reason. */
export async function listPendingDownloads(limit = 20) {
  const rows = await getDatabase().getAllAsync(
    `SELECT message_id AS messageId FROM attachments
      WHERE direction = 'in' AND state = 'pending'
      ORDER BY message_id ASC LIMIT ?;`,
    limit,
  );
  return rows.map((r) => r.messageId);
}

/** Every blob file name the database still refers to (for orphan cleanup). */
export async function listAttachmentFileNames() {
  const rows = await getDatabase().getAllAsync(
    'SELECT file_name AS fileName FROM attachments WHERE file_name IS NOT NULL;',
  );
  return new Set(rows.map((r) => r.fileName));
}
