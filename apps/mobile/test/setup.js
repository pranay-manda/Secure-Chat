/* global jest */
/**
 * Native module fakes. Their state lives on globalThis, so `jest.resetModules()` behaves like a
 * force-close + relaunch: all JS memory is gone, but "device storage" survives.
 */
process.env.EXPO_PUBLIC_API_URL = 'http://api.test';

globalThis.__device = { secureStore: new Map(), sqliteFiles: new Map(), sqliteBroken: false };

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(async (key) => globalThis.__device.secureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key, value) => {
    globalThis.__device.secureStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key) => {
    globalThis.__device.secureStore.delete(key);
  }),
}));

jest.mock('expo-crypto', () => {
  const nodeCrypto = require('node:crypto');
  return {
    randomUUID: () => nodeCrypto.randomUUID(),
    getRandomBytesAsync: async (count) => new Uint8Array(nodeCrypto.randomBytes(count)),
  };
});

/**
 * expo-sqlite backed by sql.js (real SQLite compiled to WebAssembly), with SQLCipher-like key
 * semantics: a database file is bound to the first raw key used and refuses any other key.
 */
jest.mock('expo-sqlite', () => {
  const initSqlJs = require('sql.js');
  let sqlPromise;
  const files = () => globalThis.__device.sqliteFiles;
  const toParams = (params) =>
    params.length === 1 && Array.isArray(params[0]) ? params[0] : params;

  async function connect(name) {
    sqlPromise ??= initSqlJs();
    const SQL = await sqlPromise;
    if (!files().has(name)) files().set(name, { key: null, db: new SQL.Database() });
    const file = files().get(name);
    let keyOk = false;
    const requireKey = () => {
      if (!keyOk) throw new Error('file is not a database');
    };
    const rows = (sql, params) => {
      const stmt = file.db.prepare(sql);
      try {
        stmt.bind(toParams(params));
        const out = [];
        while (stmt.step()) out.push(stmt.getAsObject());
        return out;
      } finally {
        stmt.free();
      }
    };

    return {
      async execAsync(sql) {
        const key = /PRAGMA key = "x'([0-9a-f]+)'"/.exec(sql);
        if (key) {
          file.key ??= key[1];
          keyOk = file.key === key[1];
          return;
        }
        requireKey();
        file.db.exec(sql);
      },
      async getFirstAsync(sql, ...params) {
        if (/PRAGMA cipher_version/.test(sql)) return { cipher_version: '4.7.0 community' };
        requireKey();
        return rows(sql, params)[0] ?? null;
      },
      async getAllAsync(sql, ...params) {
        requireKey();
        return rows(sql, params);
      },
      async runAsync(sql, ...params) {
        requireKey();
        file.db.run(sql, toParams(params));
        return { changes: file.db.getRowsModified() };
      },
      async withTransactionAsync(fn) {
        requireKey();
        file.db.exec('BEGIN');
        try {
          await fn();
          file.db.exec('COMMIT');
        } catch (err) {
          file.db.exec('ROLLBACK');
          throw err;
        }
      },
      async closeAsync() {},
    };
  }

  return {
    openDatabaseAsync: jest.fn(async (name) => {
      // Simulates the native library failing to load (e.g. missing libcrypto.so).
      if (globalThis.__device.sqliteBroken) throw new Error('dlopen failed: libcrypto.so');
      return connect(name);
    }),
    deleteDatabaseAsync: jest.fn(async (name) => {
      files().delete(name);
    }),
  };
});

/**
 * pusher-js test double. Each instance belongs to the device that created it
 * (`globalThis.__device.pusher`), so tests can push events into one device's connection.
 * Subscriptions are authorised through the app's real customHandler (POST /pusher/auth).
 */
jest.mock('pusher-js', () => {
  class FakeChannel {
    constructor(name) {
      this.name = name;
      this.handlers = new Map();
    }
    bind(event, fn) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(fn);
    }
    unbind_all() {
      this.handlers.clear();
    }
    emit(event, data) {
      for (const fn of this.handlers.get(event) ?? []) fn(data);
    }
  }

  // Same export shape as pusher-js's React Native build: `module.exports.Pusher = Pusher`.
  class FakePusher {
    constructor(key, options) {
      this.key = key;
      this.options = options;
      this.channels = new Map();
      this.connectionHandlers = [];
      this.state = 'connecting';
      this.auths = [];
      this.connection = { bind: (event, fn) => this.connectionHandlers.push(fn) };
      globalThis.__device.pusher = this;
    }
    subscribe(name) {
      const channel = new FakeChannel(name);
      this.channels.set(name, channel);
      this.ready = this.connect();
      return channel;
    }
    /** Connection lost (e.g. network drop): events published meanwhile are missed. */
    drop() {
      this.setState('unavailable');
    }
    /** Connection restored: pusher-js re-subscribes, which fires subscription_succeeded. */
    reconnect() {
      this.ready = this.connect();
      return this.ready;
    }
    unsubscribe(name) {
      this.channels.delete(name);
    }
    disconnect() {
      this.setState('disconnected');
      this.disconnected = true;
    }
    setState(current) {
      const previous = this.state;
      this.state = current;
      for (const fn of this.connectionHandlers) fn({ previous, current });
    }
    /** Simulates (re)connecting: authorise every channel, then report subscription success. */
    async connect() {
      this.setState('connected');
      for (const channel of this.channels.values()) {
        const auth = await new Promise((resolve, reject) => {
          this.options.channelAuthorization.customHandler(
            { socketId: '1234.5678', channelName: channel.name },
            (err, data) => (err ? reject(err) : resolve(data)),
          );
        });
        this.auths.push({ channel: channel.name, auth });
        channel.emit('pusher:subscription_succeeded', {});
      }
    }
    /** Server push to a channel this client subscribed to (ignored while disconnected). */
    deliver(channelName, event, data) {
      if (this.state !== 'connected') return false;
      this.channels.get(channelName)?.emit(event, data);
      return true;
    }
  }
  return { Pusher: FakePusher };
});

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn((listener) => {
    const listeners = (globalThis.__device.netListeners ??= new Set());
    listeners.add(listener);
    return () => listeners.delete(listener);
  }),
  fetch: jest.fn(async () => ({ isConnected: true })),
}));

/**
 * expo-notifications test double. Per-device state lives in `globalThis.__device.notify`
 * (permission, token, listeners) so tests can grant/deny permission and rotate tokens.
 */
jest.mock('expo-notifications', () => {
  const state = () =>
    (globalThis.__device.notify ??= {
      permission: { granted: true, canAskAgain: true },
      token: 'ExponentPushToken[deviceToken_0000000001]',
      tokenListeners: new Set(),
      requested: 0,
      unregistered: 0,
      handler: null,
    });
  return {
    AndroidImportance: { HIGH: 4, MAX: 5 },
    AndroidNotificationVisibility: { PRIVATE: 0 },
    setNotificationHandler: jest.fn((handler) => {
      globalThis.__notificationHandler = handler;
    }),
    setNotificationChannelAsync: jest.fn(async () => null),
    getPermissionsAsync: jest.fn(async () => ({ ...state().permission })),
    requestPermissionsAsync: jest.fn(async () => {
      state().requested += 1;
      return { ...state().permission };
    }),
    getExpoPushTokenAsync: jest.fn(async () => {
      if (state().tokenError) throw state().tokenError;
      // Like the real library: fetching a token also notifies push-token listeners with the
      // device (FCM) token.
      for (const listener of state().tokenListeners) {
        setTimeout(() => listener({ type: 'android', data: `fcm:${state().token}` }), 0);
      }
      return { type: 'expo', data: state().token };
    }),
    addPushTokenListener: jest.fn((listener) => {
      state().tokenListeners.add(listener);
      return { remove: () => state().tokenListeners.delete(listener) };
    }),
    addNotificationReceivedListener: jest.fn(() => ({ remove() {} })),
    // Tap that launched the app (cold start), kept until cleared, like the native module.
    getLastNotificationResponse: jest.fn(() => globalThis.__device.notify?.lastResponse ?? null),
    clearLastNotificationResponse: jest.fn(() => {
      if (globalThis.__device.notify) globalThis.__device.notify.lastResponse = null;
    }),
    // Taps while running/backgrounded: tests call globalThis.__device.tapListeners.
    addNotificationResponseReceivedListener: jest.fn((listener) => {
      const listeners = (globalThis.__device.tapListeners ??= new Set());
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    }),
    dismissAllNotificationsAsync: jest.fn(async () => {}),
    unregisterForNotificationsAsync: jest.fn(async () => {
      state().unregistered += 1;
    }),
  };
});

// The Signal native module runs the official libsignal (Node build of the same release).
jest.mock('../modules/signal-protocol', () => ({
  isSignalAvailable: () => true,
  getSignalNative: () => require('./mocks/signalNativeMock').signalNativeMock,
}));
