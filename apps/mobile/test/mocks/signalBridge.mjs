/**
 * Runs inside a child Node process (see signalNativeMock.js): libsignal is an ES module with a
 * native addon that Jest cannot load. Same stateless contract as SignalProtocolModule.kt,
 * implemented with the official libsignal Node build (same 0.105.0 release as Android).
 */
import {
  Fingerprint,
  IdentityChange,
  IdentityKeyPair,
  IdentityKeyStore,
  KEMKeyPair,
  KEMPublicKey,
  KyberPreKeyRecord,
  KyberPreKeyStore,
  PreKeyBundle,
  PreKeyRecord,
  PreKeySignalMessage,
  PreKeyStore,
  PrivateKey,
  ProtocolAddress,
  PublicKey,
  SessionRecord,
  SessionStore,
  SignalMessage,
  SignedPreKeyRecord,
  SignedPreKeyStore,
  processPreKeyBundle,
  signalDecrypt,
  signalDecryptPreKey,
  signalEncrypt,
} from '@signalapp/libsignal-client';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Per-call in-memory stores seeded from the records JS passes in (mirrors Context in Kotlin). */
function context(local, remote) {
  const identityKeyPair = IdentityKeyPair.deserialize(unb64(local.identityKeyPair));
  const localAddress = ProtocolAddress.new(local.name, local.deviceId);
  const remoteAddress = ProtocolAddress.new(remote.name, remote.deviceId);
  const state = {
    session: remote.session ? SessionRecord.deserialize(unb64(remote.session)) : null,
    remoteIdentity: remote.identityKey ? PublicKey.deserialize(unb64(remote.identityKey)) : null,
    preKeys: new Map(),
    signedPreKeys: new Map(),
    kyberPreKeys: new Map(),
  };

  const identityStore = new (class extends IdentityKeyStore {
    async getIdentityKey() {
      return identityKeyPair.privateKey;
    }
    async getLocalRegistrationId() {
      return local.registrationId;
    }
    async saveIdentity(_address, key) {
      const changed = state.remoteIdentity && !state.remoteIdentity.equals(key);
      state.remoteIdentity = key;
      return changed ? IdentityChange.ReplacedExisting : IdentityChange.NewOrUnchanged;
    }
    async isTrustedIdentity(_address, key) {
      return !state.remoteIdentity || state.remoteIdentity.equals(key);
    }
    async getIdentity() {
      return state.remoteIdentity;
    }
  })();
  const sessionStore = new (class extends SessionStore {
    async saveSession(_address, record) {
      state.session = record;
    }
    async getSession() {
      return state.session;
    }
    async getExistingSessions() {
      return state.session ? [state.session] : [];
    }
  })();
  const preKeyStore = new (class extends PreKeyStore {
    async savePreKey(id, record) {
      state.preKeys.set(id, record);
    }
    async getPreKey(id) {
      const record = state.preKeys.get(id);
      if (!record) throw codedError('MISSING_PREKEY', 'Referenced pre-key not found');
      return record;
    }
    async removePreKey(id) {
      state.preKeys.delete(id);
    }
  })();
  const signedPreKeyStore = new (class extends SignedPreKeyStore {
    async saveSignedPreKey(id, record) {
      state.signedPreKeys.set(id, record);
    }
    async getSignedPreKey(id) {
      return state.signedPreKeys.get(id);
    }
  })();
  const kyberPreKeyStore = new (class extends KyberPreKeyStore {
    async saveKyberPreKey(id, record) {
      state.kyberPreKeys.set(id, record);
    }
    async getKyberPreKey(id) {
      return state.kyberPreKeys.get(id);
    }
    async markKyberPreKeyUsed() {}
  })();

  return {
    state,
    localAddress,
    remoteAddress,
    stores: { identityStore, sessionStore, preKeyStore, signedPreKeyStore, kyberPreKeyStore },
    result: () => ({
      session: state.session ? b64(state.session.serialize()) : null,
      remoteIdentityKey: state.remoteIdentity ? b64(state.remoteIdentity.serialize()) : null,
      remoteRegistrationId: remoteRegistrationIdOf(state.session),
    }),
  };
}

function remoteRegistrationIdOf(session) {
  try {
    return session ? session.remoteRegistrationId() : null;
  } catch {
    return null;
  }
}

/**
 * The sender identity key a PreKeySignalMessage claims. The Node build has no accessor for it
 * (Android has PreKeySignalMessage.getIdentityKey()), so libsignal itself is asked: it hands the
 * key to IdentityKeyStore.isTrustedIdentity before using any other state, and answering "not
 * trusted" stops processing right there.
 */
async function claimedIdentityKey(message) {
  let claimed = null;
  const address = ProtocolAddress.new('probe', 1);
  const probe = new (class extends IdentityKeyStore {
    async getIdentityKey() {
      return PrivateKey.generate();
    }
    async getLocalRegistrationId() {
      return 1;
    }
    async saveIdentity() {
      return IdentityChange.NewOrUnchanged;
    }
    async isTrustedIdentity(_address, key) {
      claimed = key;
      return false;
    }
    async getIdentity() {
      return null;
    }
  })();
  const none = new (class extends SessionStore {
    async saveSession() {}
    async getSession() {
      return null;
    }
    async getExistingSessions() {
      return [];
    }
  })();
  await signalDecryptPreKey(message, address, address, none, probe, null, null, null).catch(
    () => {},
  );
  return claimed;
}

async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code && /^[A-Z_]+$/.test(err.code)) throw err;
    const name = err?.constructor?.name ?? '';
    if (/Untrusted/i.test(name) || /untrusted identity/i.test(err.message)) {
      throw codedError('UNTRUSTED_IDENTITY', 'Peer identity key changed');
    }
    if (/duplicate/i.test(err.message)) throw codedError('DUPLICATE_MESSAGE', err.message);
    throw codedError('SIGNAL_ERROR', err.message);
  }
}

export const bridge = {
  async generateIdentity() {
    const identity = IdentityKeyPair.generate();
    return {
      identityKeyPair: b64(identity.serialize()),
      identityKey: b64(identity.publicKey.serialize()),
      registrationId: 1 + Math.floor(Math.random() * 16380),
    };
  },

  async generateSignedPreKey(identityKeyPair, keyId) {
    const identity = IdentityKeyPair.deserialize(unb64(identityKeyPair));
    const key = PrivateKey.generate();
    const signature = identity.privateKey.sign(key.getPublicKey().serialize());
    const record = SignedPreKeyRecord.new(keyId, Date.now(), key.getPublicKey(), key, signature);
    return {
      keyId,
      record: b64(record.serialize()),
      publicKey: b64(key.getPublicKey().serialize()),
      signature: b64(signature),
    };
  },

  async generateKyberPreKey(identityKeyPair, keyId) {
    const identity = IdentityKeyPair.deserialize(unb64(identityKeyPair));
    const keyPair = KEMKeyPair.generate();
    const signature = identity.privateKey.sign(keyPair.getPublicKey().serialize());
    const record = KyberPreKeyRecord.new(keyId, Date.now(), keyPair, signature);
    return {
      keyId,
      record: b64(record.serialize()),
      publicKey: b64(keyPair.getPublicKey().serialize()),
      signature: b64(signature),
    };
  },

  async generatePreKeys(startId, count) {
    return Array.from({ length: count }, (_, offset) => {
      const keyId = startId + offset;
      const key = PrivateKey.generate();
      const record = PreKeyRecord.new(keyId, key.getPublicKey(), key);
      return {
        keyId,
        record: b64(record.serialize()),
        publicKey: b64(key.getPublicKey().serialize()),
      };
    });
  },

  async preKeyMessageInfo(body) {
    const message = PreKeySignalMessage.deserialize(unb64(body));
    const identityKey = await claimedIdentityKey(message);
    return {
      preKeyId: message.preKeyId(),
      signedPreKeyId: message.signedPreKeyId(),
      identityKey: identityKey ? b64(identityKey.serialize()) : null,
      registrationId: message.registrationId(),
    };
  },

  async securityCode(iterations, version, localName, localKey, remoteName, remoteKey) {
    return guard(async () =>
      Fingerprint.new(
        iterations,
        version,
        new Uint8Array(Buffer.from(localName, 'utf8')),
        PublicKey.deserialize(unb64(localKey)),
        new Uint8Array(Buffer.from(remoteName, 'utf8')),
        PublicKey.deserialize(unb64(remoteKey)),
      )
        .displayableFingerprint()
        .toString(),
    );
  },

  async processPreKeyBundle(local, remote, bundle) {
    return guard(async () => {
      const ctx = context(local, remote);
      const preKeyBundle = PreKeyBundle.new(
        bundle.registrationId,
        bundle.signalDeviceId,
        bundle.oneTimePreKey?.keyId ?? null,
        bundle.oneTimePreKey ? PublicKey.deserialize(unb64(bundle.oneTimePreKey.publicKey)) : null,
        bundle.signedPreKey.keyId,
        PublicKey.deserialize(unb64(bundle.signedPreKey.publicKey)),
        unb64(bundle.signedPreKey.signature),
        PublicKey.deserialize(unb64(bundle.identityKey)),
        bundle.kyberPreKey.keyId,
        KEMPublicKey.deserialize(unb64(bundle.kyberPreKey.publicKey)),
        unb64(bundle.kyberPreKey.signature),
      );
      await processPreKeyBundle(
        preKeyBundle,
        ctx.remoteAddress,
        ctx.localAddress,
        ctx.stores.sessionStore,
        ctx.stores.identityStore,
      );
      return ctx.result();
    });
  },

  async encrypt(local, remote, plaintext) {
    return guard(async () => {
      const ctx = context(local, remote);
      const message = await signalEncrypt(
        unb64(plaintext),
        ctx.remoteAddress,
        ctx.localAddress,
        ctx.stores.sessionStore,
        ctx.stores.identityStore,
      );
      return { ...ctx.result(), type: message.type(), body: b64(message.serialize()) };
    });
  },

  async decrypt(local, remote, input) {
    return guard(async () => {
      const ctx = context(local, remote);
      if (input.preKey) {
        const record = PreKeyRecord.deserialize(unb64(input.preKey));
        ctx.state.preKeys.set(record.id(), record);
      }
      for (const raw of input.signedPreKeys ?? []) {
        const record = SignedPreKeyRecord.deserialize(unb64(raw));
        ctx.state.signedPreKeys.set(record.id(), record);
      }
      for (const raw of input.kyberPreKeys ?? []) {
        const record = KyberPreKeyRecord.deserialize(unb64(raw));
        ctx.state.kyberPreKeys.set(record.id(), record);
      }
      const body = unb64(input.body);
      let plaintext;
      let usedPreKeyId = null;
      if (input.type === 3) {
        const message = PreKeySignalMessage.deserialize(body);
        usedPreKeyId = message.preKeyId();
        plaintext = await signalDecryptPreKey(
          message,
          ctx.remoteAddress,
          ctx.localAddress,
          ctx.stores.sessionStore,
          ctx.stores.identityStore,
          ctx.stores.preKeyStore,
          ctx.stores.signedPreKeyStore,
          ctx.stores.kyberPreKeyStore,
        );
      } else {
        plaintext = await signalDecrypt(
          SignalMessage.deserialize(body),
          ctx.remoteAddress,
          ctx.localAddress,
          ctx.stores.sessionStore,
          ctx.stores.identityStore,
        );
      }
      return { ...ctx.result(), plaintext: b64(plaintext), usedPreKeyId };
    });
  },
};

// IPC loop: { id, method, args } -> { id, result } | { id, error: { code, message } }
process.on('message', async ({ id, method, args }) => {
  try {
    process.send({ id, result: await bridge[method](...args) });
  } catch (err) {
    process.send({ id, error: { code: err.code ?? 'SIGNAL_ERROR', message: err.message } });
  }
});
