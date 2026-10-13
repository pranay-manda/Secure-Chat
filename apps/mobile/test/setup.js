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
    // Notifications currently shown in the tray (tests put them in notify.presented).
    getPresentedNotificationsAsync: jest.fn(async () => [...(state().presented ?? [])]),
    dismissNotificationAsync: jest.fn(async (identifier) => {
      state().presented = (state().presented ?? []).filter(
        (n) => n.request.identifier !== identifier,
      );
    }),
    unregisterForNotificationsAsync: jest.fn(async () => {
      state().unregistered += 1;
    }),
  };
});

/**
 * expo-local-authentication test double (the OS prompt). Per-device state in
 * `globalThis.__device.auth`: `level` (enrolled security level) and `results`, a queue of
 * outcomes for the next prompts ({ success: true } or { success: false, error }).
 */
jest.mock('expo-local-authentication', () => {
  const state = () =>
    (globalThis.__device.auth ??= { level: 3, types: [1], results: [], prompts: [] });
  return {
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
    getEnrolledLevelAsync: jest.fn(async () => state().level),
    supportedAuthenticationTypesAsync: jest.fn(async () => state().types),
    authenticateAsync: jest.fn(async (options) => {
      state().prompts.push(options);
      return state().results.shift() ?? { success: true };
    }),
  };
});

/**
 * expo-contacts test double (new Contact API). Per-device `globalThis.__device.contacts`:
 * `status` (undetermined | granted | denied), `grantOnRequest`, `book` (array of
 * { fullName, phones: [{ number }] }), and counters for permission prompts and reads.
 */
jest.mock('expo-contacts', () => {
  const state = () =>
    (globalThis.__device.contacts ??= {
      status: 'undetermined',
      canAskAgain: true,
      grantOnRequest: true,
      book: [],
      requests: 0,
      reads: [],
    });
  return {
    ContactField: { FULL_NAME: 'fullName', PHONES: 'phones' },
    getPermissionsAsync: jest.fn(async () => ({
      status: state().status,
      canAskAgain: state().canAskAgain,
    })),
    requestPermissionsAsync: jest.fn(async () => {
      const s = state();
      s.requests += 1;
      if (s.status === 'undetermined') {
        s.status = s.grantOnRequest ? 'granted' : 'denied';
        s.canAskAgain = s.grantOnRequest;
      }
      return { status: s.status, canAskAgain: s.canAskAgain };
    }),
    Contact: {
      getAllDetails: jest.fn(async (fields, { limit, offset }) => {
        const s = state();
        if (s.status !== 'granted') throw new Error('Missing contacts permission');
        s.reads.push({ fields, limit, offset });
        return s.book.slice(offset, offset + limit);
      }),
    },
  };
});

/** expo-screen-capture test double: tracks which keys currently prevent capture. */
jest.mock('expo-screen-capture', () => {
  const active = () => (globalThis.__device.screenCapture ??= new Set());
  return {
    preventScreenCaptureAsync: jest.fn(async (key) => {
      active().add(key);
    }),
    allowScreenCaptureAsync: jest.fn(async (key) => {
      active().delete(key);
    }),
  };
});

// The Signal native module runs the official libsignal (Node build of the same release).
jest.mock('../modules/signal-protocol', () => ({
  isSignalAvailable: () => true,
  getSignalNative: () => require('./mocks/signalNativeMock').signalNativeMock,
}));

// Android's call foreground service has no Node equivalent; the real wrapper would also load
// the `expo` package, which replaces the global fetch the tests' fake server relies on.
jest.mock('../modules/call-service', () => ({
  startCallService: jest.fn(() => false),
  stopCallService: jest.fn(),
}));

// Media: expo-file-system on a per-device temp directory, and the MediaCrypto native module as
// a Node implementation of the same blob format (see mocks/).
jest.mock('expo-file-system', () => require('./mocks/fileSystemMock'));
jest.mock('../modules/media-crypto', () => ({
  isMediaCryptoAvailable: () => true,
  getMediaCrypto: () => require('./mocks/mediaCryptoMock').mediaCryptoMock,
}));

/** expo-image-picker: the next result is `globalThis.__device.pickResult` (default: cancelled). */
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(
    async () => globalThis.__device.pickResult ?? { canceled: true },
  ),
}));

/**
 * expo-audio: a recorder that "records" into the device's cache/Audio directory and a player
 * with observable state. Per-device `globalThis.__device.audio`: `permission`, `players`.
 */
jest.mock('expo-audio', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { Paths } = require('./mocks/fileSystemMock');
  const state = () =>
    (globalThis.__device.audio ??= {
      permission: { granted: true, canAskAgain: true },
      players: [],
    });
  const recorder = {
    isRecording: false,
    uri: null,
    durationMillis: 0,
    async prepareToRecordAsync() {
      const dir = path.join(Paths.cache.path, 'Audio');
      fs.mkdirSync(dir, { recursive: true });
      this.uri = `file://${path.join(dir, `recording-${Date.now()}.m4a`).replace(/\\/g, '/')}`;
    },
    record() {
      this.isRecording = true;
      fs.writeFileSync(decodeURI(this.uri.slice(7)), Buffer.from('fake-aac-audio'.repeat(200)));
    },
    async stop() {
      this.isRecording = false;
    },
    // Microphone level for the waveform (dBFS; speech-like).
    getStatus() {
      return { isRecording: this.isRecording, durationMillis: this.durationMillis, metering: -20 };
    },
  };
  return {
    requestRecordingPermissionsAsync: jest.fn(async () => ({ ...state().permission })),
    useAudioRecorder: () => recorder,
    useAudioRecorderState: () => ({
      isRecording: recorder.isRecording,
      durationMillis: recorder.durationMillis,
      canRecord: true,
    }),
    // Like the real hook: one player per component for its whole life.
    useAudioPlayer: (initialSource = null) =>
      require('react').useState(() => createPlayer(initialSource))[0],
    useAudioPlayerStatus: (player) => ({
      playing: player.playing,
      currentTime: 0,
      duration: 0,
      didJustFinish: false,
    }),
    setAudioModeAsync: jest.fn(async () => {}),
  };

  function createPlayer(initialSource) {
    {
      const player = {
        source: initialSource,
        playing: false,
        replace(source) {
          this.source = source;
        },
        play() {
          this.playing = true;
        },
        pause() {
          this.playing = false;
        },
        rate: 1,
        setPlaybackRate(rate) {
          this.rate = rate;
        },
        seeks: [],
        async seekTo(seconds) {
          this.seeks.push(seconds);
        },
      };
      state().players.push(player);
      return player;
    }
  }
});

/**
 * expo-camera: a camera that "takes" photos and videos into the device's cache/Camera
 * directory (like the real module). `globalThis.__device.cameraPermission` overrides access.
 */
jest.mock('expo-camera', () => {
  const React = require('react');
  const fs = require('node:fs');
  const path = require('node:path');
  const { Paths } = require('./mocks/fileSystemMock');
  const write = (extension) => {
    const dir = path.join(Paths.cache.path, 'Camera');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`,
    );
    fs.writeFileSync(file, Buffer.alloc(4000, 7));
    return `file://${file.split(path.sep).join('/')}`;
  };
  const CameraView = React.forwardRef(function CameraView(_props, ref) {
    React.useImperativeHandle(ref, () => ({
      takePictureAsync: async () => ({ uri: write('jpg'), width: 1080, height: 1920 }),
      recordAsync: () =>
        new Promise((resolve) => {
          globalThis.__device.finishRecording = () => resolve({ uri: write('mp4') });
        }),
      stopRecording: () => globalThis.__device.finishRecording?.(),
    }));
    return null;
  });
  const permission = () =>
    globalThis.__device.cameraPermission ?? { granted: true, canAskAgain: true, status: 'granted' };
  return {
    CameraView,
    useCameraPermissions: () => [permission(), jest.fn(async () => permission())],
    useMicrophonePermissions: () => [
      { granted: true, canAskAgain: true, status: 'granted' },
      jest.fn(async () => ({ granted: true })),
    ],
  };
});

jest.mock('expo-video', () => ({
  useVideoPlayer: jest.fn(() => ({ play() {}, pause() {} })),
  VideoView: () => null,
}));
