import { getRandomBytesAsync } from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

import { deleteSecureItem, getSecureItem, SECURE_KEYS, setSecureItem } from '../lib/secureStorage';
import { MIGRATIONS } from './migrations';

export const DATABASE_NAME = 'securechat.db';

const KEY_HEX = /^[0-9a-f]{64}$/;

let db = null;

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 256-bit random key, created once and kept only in secure storage. */
async function getOrCreateKey() {
  const existing = await getSecureItem(SECURE_KEYS.DB_KEY);
  if (existing && KEY_HEX.test(existing)) return existing;

  const key = toHex(await getRandomBytesAsync(32));
  await setSecureItem(SECURE_KEYS.DB_KEY, key);
  return key;
}

async function openWithKey(key) {
  const conn = await SQLite.openDatabaseAsync(DATABASE_NAME);
  try {
    // Raw-key form (x'...'): the key is already random, so SQLCipher skips password derivation.
    await conn.execAsync(`PRAGMA key = "x'${key}'";`);
    // Fail closed if this build is not linked against SQLCipher: never store data unencrypted.
    const cipher = await conn.getFirstAsync('PRAGMA cipher_version;');
    if (!cipher?.cipher_version) {
      throw new Error('SQLCipher is not available in this build');
    }
    // Reading the schema fails here if the key does not match the file.
    await conn.getFirstAsync('SELECT count(*) AS n FROM sqlite_master;');
    return { conn, cipherVersion: cipher.cipher_version };
  } catch (err) {
    await conn.closeAsync().catch(() => {});
    throw err;
  }
}

async function migrate(conn) {
  const row = await conn.getFirstAsync('PRAGMA user_version;');
  const current = row?.user_version ?? 0;
  for (const migration of MIGRATIONS.filter((m) => m.version > current)) {
    await conn.withTransactionAsync(async () => {
      await conn.execAsync(migration.sql);
      await conn.execAsync(`PRAGMA user_version = ${migration.version};`);
    });
  }
}

/**
 * Opens (creating if needed) the SQLCipher-encrypted local database.
 * If the file cannot be decrypted (key lost, e.g. keychain reset), it is discarded and recreated:
 * MongoDB is the source of truth, so local data can always be re-synced.
 */
export async function openDatabase() {
  if (db) return db;

  const key = await getOrCreateKey();
  let opened;
  try {
    opened = await openWithKey(key);
  } catch (err) {
    if (/SQLCipher is not available/.test(err.message)) throw err;
    await SQLite.deleteDatabaseAsync(DATABASE_NAME).catch(() => {});
    opened = await openWithKey(key);
  }

  await opened.conn.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  await migrate(opened.conn);
  db = { conn: opened.conn, cipherVersion: opened.cipherVersion };
  return db;
}

export function getDatabase() {
  if (!db) throw new Error('Database is not open');
  return db.conn;
}

export async function getMeta(key) {
  const row = await getDatabase().getFirstAsync('SELECT value FROM meta WHERE key = ?;', key);
  return row?.value ?? null;
}

export async function setMeta(key, value) {
  await getDatabase().runAsync(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
    key,
    value,
  );
}

export function getCipherVersion() {
  return db?.cipherVersion ?? null;
}

/** Closes and deletes the database file and its key. Used on logout and session loss. */
export async function destroyDatabase() {
  if (db) {
    await db.conn.closeAsync().catch(() => {});
    db = null;
  }
  await SQLite.deleteDatabaseAsync(DATABASE_NAME).catch(() => {});
  await deleteSecureItem(SECURE_KEYS.DB_KEY);
}
