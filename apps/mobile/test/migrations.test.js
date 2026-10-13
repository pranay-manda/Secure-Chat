/* global jest */
import { resetDevice } from './helpers';

/**
 * Schema upgrades run on phones that already have data: they must keep every existing row
 * and be safe to run again after a crash or restart.
 */
const ALL = jest.requireActual('../src/db/migrations').MIGRATIONS;

/** The database module as an app version that ships only migrations up to `version`. */
function databaseAt(version) {
  let database;
  jest.isolateModules(() => {
    jest.doMock('../src/db/migrations', () => ({
      MIGRATIONS: ALL.filter((m) => m.version <= version),
    }));
    database = require('../src/db/database');
  });
  jest.dontMock('../src/db/migrations');
  return database;
}

describe('migration 5 (identity changes)', () => {
  beforeEach(() => resetDevice());

  it('upgrades a v4 database in place, keeping conversations, messages, sessions and outbox', async () => {
    const v4 = databaseAt(4);
    await v4.openDatabase();
    const old = v4.getDatabase();
    await old.execAsync(`
      INSERT INTO conversations (peer_user_id, title, created_at, locked) VALUES ('peer1', 'Bob', 1, 1);
      INSERT INTO messages (server_message_id, peer_user_id, direction, body, status, created_at)
        VALUES ('m1', 'peer1', 'in', 'hello', 'received', 2);
      INSERT INTO signal_sessions (address, record, updated_at) VALUES ('peer1.1', 'session', 3);
      INSERT INTO signal_identities (address, identity_key, first_seen_at) VALUES ('peer1.1', 'K1', 3);
      INSERT INTO outbox (client_message_id, recipient_user_id, recipient_device_id, type, ciphertext, created_at)
        VALUES ('c1', 'peer1', 'dev1', 2, 'cipher', 4);
      INSERT INTO message_envelopes (envelope_id, seq, message_id, sender_user_id, sender_device_id,
        sender_signal_device_id, type, ciphertext, received_at)
        VALUES ('e1', 1, 'm2', 'peer1', 'dev1', 1, 3, 'pending-cipher', 5);
    `);
    expect((await old.getFirstAsync('PRAGMA user_version;')).user_version).toBe(4);

    // App update: the new version opens the same encrypted file and migrates it.
    const v5 = databaseAt(5);
    await v5.openDatabase();
    const db = v5.getDatabase();
    expect((await db.getFirstAsync('PRAGMA user_version;')).user_version).toBe(5);
    expect(await db.getFirstAsync('SELECT title, locked FROM conversations;')).toEqual({
      title: 'Bob',
      locked: 1,
    });
    expect((await db.getFirstAsync('SELECT body FROM messages;')).body).toBe('hello');
    expect(
      (await db.getFirstAsync('SELECT identity_key FROM signal_identities;')).identity_key,
    ).toBe('K1');
    expect((await db.getFirstAsync('SELECT record FROM signal_sessions;')).record).toBe('session');
    expect(
      await db.getFirstAsync('SELECT ciphertext, recipient_registration_id AS r FROM outbox;'),
    ).toEqual({ ciphertext: 'cipher', r: null });
    expect((await db.getFirstAsync('SELECT ciphertext FROM message_envelopes;')).ciphertext).toBe(
      'pending-cipher',
    );
    expect((await db.getFirstAsync('SELECT count(*) AS n FROM identity_changes;')).n).toBe(0);

    // Restart after the upgrade: nothing runs twice, nothing breaks.
    const again = databaseAt(5);
    await again.openDatabase();
    expect((await again.getDatabase().getFirstAsync('SELECT count(*) AS n FROM messages;')).n).toBe(
      1,
    );
  });

  it('allows only one undecided identity change per contact', async () => {
    const database = databaseAt(5);
    await database.openDatabase();
    const db = database.getDatabase();
    const insert = (status) =>
      db.runAsync(
        `INSERT INTO identity_changes
           (peer_user_id, address, previous_identity_key, new_identity_key, status, detected_at)
         VALUES ('peer1', 'peer1.1', 'K1', 'K2', ?, 1);`,
        status,
      );
    await insert('accepted');
    await insert('pending');
    await expect(insert('pending')).rejects.toThrow();
    await expect(insert('rejected-by-typo')).rejects.toThrow();
  });
});

describe('migration 6 (call history)', () => {
  beforeEach(() => resetDevice());

  it('upgrades a v5 database in place: existing chats stay, an empty call history appears', async () => {
    const v5 = databaseAt(5);
    await v5.openDatabase();
    await v5.getDatabase().execAsync(`
      INSERT INTO conversations (peer_user_id, title, created_at) VALUES ('peer1', 'Bob', 1);
      INSERT INTO messages (server_message_id, peer_user_id, direction, body, status, created_at)
        VALUES ('m1', 'peer1', 'in', 'hello', 'received', 2);
    `);

    const v6 = databaseAt(6);
    await v6.openDatabase();
    const db = v6.getDatabase();
    expect((await db.getFirstAsync('PRAGMA user_version;')).user_version).toBe(6);
    expect((await db.getFirstAsync('SELECT body FROM messages;')).body).toBe('hello');
    expect((await db.getFirstAsync('SELECT count(*) AS n FROM call_log;')).n).toBe(0);

    const insert = (callId, direction) =>
      db.runAsync(
        `INSERT INTO call_log (call_id, peer_user_id, direction, outcome, started_at, ended_at)
         VALUES (?, 'peer1', ?, 'missed', 1, 2);`,
        callId,
        direction,
      );
    await insert('c1', 'in');
    await expect(insert('c1', 'in')).rejects.toThrow(); // one row per call
    await expect(insert('c2', 'sideways')).rejects.toThrow();

    // Restart after the upgrade: nothing runs twice.
    const again = databaseAt(6);
    await again.openDatabase();
    expect((await again.getDatabase().getFirstAsync('SELECT count(*) AS n FROM call_log;')).n).toBe(
      1,
    );
  });
});

describe('migration 7 (video calls in the call history)', () => {
  beforeEach(() => resetDevice());

  it('upgrades a v6 database in place: earlier calls become voice calls, kinds are checked', async () => {
    const v6 = databaseAt(6);
    await v6.openDatabase();
    await v6.getDatabase().execAsync(`
      INSERT INTO call_log (call_id, peer_user_id, direction, outcome, started_at, ended_at)
        VALUES ('c1', 'peer1', 'out', 'answered', 1, 2);
    `);

    const v7 = databaseAt(7);
    await v7.openDatabase();
    const db = v7.getDatabase();
    expect((await db.getFirstAsync('PRAGMA user_version;')).user_version).toBe(7);
    expect(await db.getFirstAsync('SELECT call_id AS id, kind FROM call_log;')).toEqual({
      id: 'c1',
      kind: 'voice',
    });
    const insert = (callId, kind) =>
      db.runAsync(
        `INSERT INTO call_log (call_id, peer_user_id, direction, kind, outcome, started_at, ended_at)
         VALUES (?, 'peer1', 'in', ?, 'missed', 1, 2);`,
        callId,
        kind,
      );
    await insert('c2', 'video');
    await expect(insert('c3', 'hologram')).rejects.toThrow();

    const again = databaseAt(7);
    await again.openDatabase();
    expect((await again.getDatabase().getFirstAsync('SELECT count(*) AS n FROM call_log;')).n).toBe(
      2,
    );
  });
});
