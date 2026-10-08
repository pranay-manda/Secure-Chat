/**
 * Ordered schema migrations, tracked with PRAGMA user_version. Append only; never edit a
 * shipped migration. The whole database is SQLCipher-encrypted (key in SecureStore).
 */
export const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // Phase 3A: Signal Protocol state, encrypted envelopes and sync metadata.
    // The long-term identity key pair is NOT here: it lives in SecureStore.
    version: 2,
    sql: `
      -- Our own pre-keys (serialized libsignal records, include private halves).
      CREATE TABLE IF NOT EXISTS signal_signed_prekeys (
        key_id INTEGER PRIMARY KEY NOT NULL,
        record TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signal_kyber_prekeys (
        key_id INTEGER PRIMARY KEY NOT NULL,
        record TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signal_prekeys (
        key_id INTEGER PRIMARY KEY NOT NULL,
        record TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Per-peer Signal session records and trusted (first-seen) identity keys.
      CREATE TABLE IF NOT EXISTS signal_sessions (
        address TEXT PRIMARY KEY NOT NULL,
        record TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signal_identities (
        address TEXT PRIMARY KEY NOT NULL,
        identity_key TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL
      );

      -- Which server device (UUID) currently represents a peer user (single device in v1).
      CREATE TABLE IF NOT EXISTS peer_devices (
        user_id TEXT PRIMARY KEY NOT NULL,
        device_id TEXT NOT NULL,
        signal_device_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Inbound encrypted envelopes exactly as received (crash-safe inbox).
      CREATE TABLE IF NOT EXISTS message_envelopes (
        envelope_id TEXT PRIMARY KEY NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        sender_user_id TEXT NOT NULL,
        sender_device_id TEXT NOT NULL,
        sender_signal_device_id INTEGER NOT NULL,
        type INTEGER NOT NULL,
        ciphertext TEXT NOT NULL,
        server_created_at TEXT,
        received_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_envelopes_status ON message_envelopes (status, seq);

      -- Decrypted messages (plaintext stays inside this encrypted database only).
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_message_id TEXT UNIQUE,
        server_message_id TEXT UNIQUE,
        peer_user_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_peer ON messages (peer_user_id, created_at);

      -- Sync cursors and counters (e.g. last processed envelope seq, next pre-key id).
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // Phase 3B: 1:1 conversations, delivery/read state and a crash-safe outbox.
    version: 3,
    sql: `
      -- One row per peer. The title is an optional nickname that never leaves the device.
      CREATE TABLE IF NOT EXISTS conversations (
        peer_user_id TEXT PRIMARY KEY NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        last_message_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_recent ON conversations (last_message_at);
      INSERT OR IGNORE INTO conversations (peer_user_id, created_at, last_message_at)
        SELECT peer_user_id, min(created_at), max(created_at) FROM messages GROUP BY peer_user_id;

      -- Outgoing: sending -> sent -> delivered -> read, or failed (retryable).
      -- Incoming: received -> read, or undecryptable.
      ALTER TABLE messages ADD COLUMN delivered_at INTEGER;
      ALTER TABLE messages ADD COLUMN read_at INTEGER;
      ALTER TABLE messages ADD COLUMN error TEXT;
      -- Incoming message read locally whose read receipt has not reached the server yet.
      ALTER TABLE messages ADD COLUMN receipt_pending INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (direction, status);

      -- Encrypted payload of an outgoing message until the server accepts it. A retry resends
      -- exactly this ciphertext with the same client_message_id (the server deduplicates),
      -- so the Signal ratchet is never advanced twice for one message.
      CREATE TABLE IF NOT EXISTS outbox (
        client_message_id TEXT PRIMARY KEY NOT NULL,
        recipient_user_id TEXT NOT NULL,
        recipient_device_id TEXT NOT NULL,
        type INTEGER NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    // Chat Lock: local access control for individual conversations (not encryption; messages
    // are already end-to-end encrypted and this whole database is SQLCipher-encrypted).
    // Never synced: the server does not know which chats are locked.
    version: 4,
    sql: `
      ALTER TABLE conversations ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversations ADD COLUMN locked_at INTEGER;
    `,
  },
  {
    // Identity-key changes ("security code changed"). The trusted key stays in
    // signal_identities until the user accepts the new one; until then the new key is only
    // recorded here, and messages encrypted with it wait (as ciphertext) in message_envelopes
    // with status 'identity_pending'. Local only: the server never learns trust decisions.
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS identity_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_user_id TEXT NOT NULL,
        address TEXT NOT NULL,
        previous_identity_key TEXT NOT NULL,
        new_identity_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
        detected_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      -- At most one undecided change per peer.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_changes_pending
        ON identity_changes (peer_user_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_envelopes_sender ON message_envelopes (sender_user_id, status);

      -- Registration id of the recipient keys the outbox ciphertext was encrypted for.
      ALTER TABLE outbox ADD COLUMN recipient_registration_id INTEGER;
    `,
  },
];
