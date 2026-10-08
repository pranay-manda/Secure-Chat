import { randomUUID } from 'node:crypto';

import {
  CiphertextMessageType,
  IdentityChange,
  IdentityKeyPair,
  IdentityKeyStore,
  KEMKeyPair,
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
  KEMPublicKey,
  processPreKeyBundle,
  signalDecrypt,
  signalDecryptPreKey,
  signalEncrypt,
} from '@signalapp/libsignal-client';
import request from 'supertest';

import { bearer } from './helpers.js';

/**
 * A simulated client device for integration tests, using the official libsignal (Node build of
 * the same 0.105.0 release the Android app uses). Private keys live only in this object, like
 * on a phone; only public material and ciphertext are sent to the API.
 *
 * State is serializable (toJSON/fromJSON) to simulate an app restart.
 */
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

class Stores {
  constructor(identityKeyPair, registrationId) {
    this.identityKeyPair = identityKeyPair;
    this.registrationId = registrationId;
    this.sessions = new Map();
    this.identities = new Map();
    this.preKeys = new Map();
    this.signedPreKeys = new Map();
    this.kyberPreKeys = new Map();
  }
}

function makeStores(state) {
  const identity = new (class extends IdentityKeyStore {
    async getIdentityKey() {
      return state.identityKeyPair.privateKey;
    }
    async getLocalRegistrationId() {
      return state.registrationId;
    }
    async saveIdentity(address, key) {
      const existing = state.identities.get(address.toString());
      state.identities.set(address.toString(), key);
      return existing && !existing.equals(key)
        ? IdentityChange.ReplacedExisting
        : IdentityChange.NewOrUnchanged;
    }
    async isTrustedIdentity(address, key) {
      const existing = state.identities.get(address.toString());
      return !existing || existing.equals(key); // trust on first use
    }
    async getIdentity(address) {
      return state.identities.get(address.toString()) ?? null;
    }
  })();
  const sessions = new (class extends SessionStore {
    async saveSession(address, record) {
      state.sessions.set(address.toString(), record);
    }
    async getSession(address) {
      return state.sessions.get(address.toString()) ?? null;
    }
    async getExistingSessions(addresses) {
      return addresses.map((a) => state.sessions.get(a.toString())).filter(Boolean);
    }
  })();
  const preKeys = new (class extends PreKeyStore {
    async savePreKey(id, record) {
      state.preKeys.set(id, record);
    }
    async getPreKey(id) {
      const record = state.preKeys.get(id);
      if (!record) throw new Error(`no pre-key ${id}`);
      return record;
    }
    async removePreKey(id) {
      state.preKeys.delete(id);
    }
  })();
  const signedPreKeys = new (class extends SignedPreKeyStore {
    async saveSignedPreKey(id, record) {
      state.signedPreKeys.set(id, record);
    }
    async getSignedPreKey(id) {
      return state.signedPreKeys.get(id);
    }
  })();
  const kyberPreKeys = new (class extends KyberPreKeyStore {
    async saveKyberPreKey(id, record) {
      state.kyberPreKeys.set(id, record);
    }
    async getKyberPreKey(id) {
      return state.kyberPreKeys.get(id);
    }
    async markKyberPreKeyUsed() {}
  })();
  return { identity, sessions, preKeys, signedPreKeys, kyberPreKeys };
}

export class SignalTestDevice {
  constructor({ app, auth, state }) {
    this.app = app;
    this.auth = auth; // { userId, deviceId, accessToken }
    this.state =
      state ?? new Stores(IdentityKeyPair.generate(), 1 + Math.floor(Math.random() * 16000));
    this.stores = makeStores(this.state);
    this.address = ProtocolAddress.new(auth.userId, 1);
  }

  /** Every private key this device holds, base64 (for leak scanning). */
  privateKeyMaterial() {
    const secrets = [b64(this.state.identityKeyPair.privateKey.serialize())];
    for (const record of this.state.preKeys.values()) {
      secrets.push(b64(record.privateKey().serialize()));
    }
    for (const record of this.state.signedPreKeys.values()) {
      secrets.push(b64(record.privateKey().serialize()));
    }
    for (const record of this.state.kyberPreKeys.values()) {
      secrets.push(b64(record.secretKey().serialize()));
    }
    return secrets;
  }

  /** Generates keys locally and uploads ONLY the public halves. */
  async registerKeys({ oneTimeCount = 5 } = {}) {
    const { identityKeyPair } = this.state;
    const signed = PrivateKey.generate();
    const signedId = 1 + Math.floor(Math.random() * 1000);
    const signedSig = identityKeyPair.privateKey.sign(signed.getPublicKey().serialize());
    this.state.signedPreKeys.set(
      signedId,
      SignedPreKeyRecord.new(signedId, Date.now(), signed.getPublicKey(), signed, signedSig),
    );

    const kyber = KEMKeyPair.generate();
    const kyberId = 1 + Math.floor(Math.random() * 1000);
    const kyberSig = identityKeyPair.privateKey.sign(kyber.getPublicKey().serialize());
    this.state.kyberPreKeys.set(
      kyberId,
      KyberPreKeyRecord.new(kyberId, Date.now(), kyber, kyberSig),
    );

    const oneTimePreKeys = [];
    for (let i = 0; i < oneTimeCount; i += 1) {
      const key = PrivateKey.generate();
      const keyId = 5000 + i;
      this.state.preKeys.set(keyId, PreKeyRecord.new(keyId, key.getPublicKey(), key));
      oneTimePreKeys.push({ keyId, publicKey: b64(key.getPublicKey().serialize()) });
    }

    const body = {
      registrationId: this.state.registrationId,
      identityKey: b64(identityKeyPair.publicKey.serialize()),
      signedPreKey: {
        keyId: signedId,
        publicKey: b64(signed.getPublicKey().serialize()),
        signature: b64(signedSig),
      },
      kyberPreKey: {
        keyId: kyberId,
        publicKey: b64(kyber.getPublicKey().serialize()),
        signature: b64(kyberSig),
      },
      oneTimePreKeys,
    };
    const res = await request(this.app).put('/keys').set(bearer(this.auth.accessToken)).send(body);
    return { res, body };
  }

  async fetchBundle(userId) {
    return request(this.app).get(`/keys/bundle/${userId}`).set(bearer(this.auth.accessToken));
  }

  /** Encrypts locally (establishing a session from the peer's bundle if needed) and sends. */
  async sendText(peer, text, { clientMessageId = randomUUID() } = {}) {
    const remote = ProtocolAddress.new(peer.userId, 1);
    let bundleRes = null;
    if (!(await this.stores.sessions.getSession(remote))) {
      bundleRes = await this.fetchBundle(peer.userId);
      if (bundleRes.status !== 200) throw new Error(`bundle ${bundleRes.status}`);
      const b = bundleRes.body.bundle;
      const bundle = PreKeyBundle.new(
        b.registrationId,
        b.signalDeviceId,
        b.oneTimePreKey?.keyId ?? null,
        b.oneTimePreKey ? PublicKey.deserialize(unb64(b.oneTimePreKey.publicKey)) : null,
        b.signedPreKey.keyId,
        PublicKey.deserialize(unb64(b.signedPreKey.publicKey)),
        unb64(b.signedPreKey.signature),
        PublicKey.deserialize(unb64(b.identityKey)),
        b.kyberPreKey.keyId,
        KEMPublicKey.deserialize(unb64(b.kyberPreKey.publicKey)),
        unb64(b.kyberPreKey.signature),
      );
      await processPreKeyBundle(
        bundle,
        remote,
        this.address,
        this.stores.sessions,
        this.stores.identity,
      );
      this.peerDeviceId = b.deviceId;
    }

    const message = await signalEncrypt(
      new TextEncoder().encode(text),
      remote,
      this.address,
      this.stores.sessions,
      this.stores.identity,
    );
    const body = {
      recipientUserId: peer.userId,
      recipientDeviceId: peer.deviceId ?? this.peerDeviceId,
      clientMessageId,
      type: message.type(),
      ciphertext: b64(message.serialize()),
    };
    const res = await request(this.app)
      .post('/messages')
      .set(bearer(this.auth.accessToken))
      .send(body);
    return { res, body, bundleRes };
  }

  async fetchEnvelopes(after = 0) {
    return request(this.app)
      .get(`/messages/envelopes?after=${after}`)
      .set(bearer(this.auth.accessToken));
  }

  /** Decrypts one envelope received from the API or Pusher. */
  async decrypt(envelope) {
    const remote = ProtocolAddress.new(envelope.senderUserId, envelope.senderSignalDeviceId);
    const bytes = unb64(envelope.ciphertext);
    const plaintext =
      envelope.type === CiphertextMessageType.PreKey
        ? await signalDecryptPreKey(
            PreKeySignalMessage.deserialize(bytes),
            remote,
            this.address,
            this.stores.sessions,
            this.stores.identity,
            this.stores.preKeys,
            this.stores.signedPreKeys,
            this.stores.kyberPreKeys,
          )
        : await signalDecrypt(
            SignalMessage.deserialize(bytes),
            remote,
            this.address,
            this.stores.sessions,
            this.stores.identity,
          );
    return new TextDecoder().decode(plaintext);
  }

  /** Serializes the full local state (what the phone persists) to simulate a restart. */
  exportState() {
    const map = (m, f) => [...m].map(([k, v]) => [k, f(v)]);
    return JSON.stringify({
      identityKeyPair: b64(this.state.identityKeyPair.serialize()),
      registrationId: this.state.registrationId,
      sessions: map(this.state.sessions, (r) => b64(r.serialize())),
      identities: map(this.state.identities, (k) => b64(k.serialize())),
      preKeys: map(this.state.preKeys, (r) => b64(r.serialize())),
      signedPreKeys: map(this.state.signedPreKeys, (r) => b64(r.serialize())),
      kyberPreKeys: map(this.state.kyberPreKeys, (r) => b64(r.serialize())),
    });
  }

  static importState(json) {
    const s = JSON.parse(json);
    const state = new Stores(
      IdentityKeyPair.deserialize(unb64(s.identityKeyPair)),
      s.registrationId,
    );
    for (const [k, v] of s.sessions) state.sessions.set(k, SessionRecord.deserialize(unb64(v)));
    for (const [k, v] of s.identities) state.identities.set(k, PublicKey.deserialize(unb64(v)));
    for (const [k, v] of s.preKeys) state.preKeys.set(k, PreKeyRecord.deserialize(unb64(v)));
    for (const [k, v] of s.signedPreKeys) {
      state.signedPreKeys.set(k, SignedPreKeyRecord.deserialize(unb64(v)));
    }
    for (const [k, v] of s.kyberPreKeys) {
      state.kyberPreKeys.set(k, KyberPreKeyRecord.deserialize(unb64(v)));
    }
    return state;
  }
}
