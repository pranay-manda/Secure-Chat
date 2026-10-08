package expo.modules.signalprotocol

import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.signal.libsignal.protocol.DuplicateMessageException
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.InvalidKeyIdException
import org.signal.libsignal.protocol.NoSessionException
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.UntrustedIdentityException
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.fingerprint.NumericFingerprintGenerator
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType
import org.signal.libsignal.protocol.kem.KEMPublicKey
import org.signal.libsignal.protocol.message.CiphertextMessage
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.message.SignalMessage
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyBundle
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SessionRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.state.impl.InMemorySignalProtocolStore
import org.signal.libsignal.protocol.util.KeyHelper

/**
 * Thin, stateless bridge to the official libsignal (org.signal:libsignal-android).
 *
 * No cryptography is implemented here: every operation calls libsignal. State (identity key pair,
 * sessions, pre-keys) is persisted by JS in the SQLCipher database / SecureStore; each call
 * receives the records it needs, runs libsignal against an in-memory store, and returns the
 * updated records for JS to save. All binary values cross the bridge as standard base64.
 */
class SignalProtocolModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SignalProtocol")

    AsyncFunction("generateIdentity") {
      val identity = IdentityKeyPair.generate()
      mapOf(
        "identityKeyPair" to b64(identity.serialize()),
        "identityKey" to b64(identity.publicKey.serialize()),
        "registrationId" to KeyHelper.generateRegistrationId(false),
      )
    }

    AsyncFunction("generateSignedPreKey") { identityKeyPair: String, keyId: Int ->
      val identity = IdentityKeyPair(unb64(identityKeyPair))
      val keyPair = ECKeyPair.generate()
      val signature = identity.privateKey.calculateSignature(keyPair.publicKey.serialize())
      val record = SignedPreKeyRecord(keyId, System.currentTimeMillis(), keyPair, signature)
      mapOf(
        "keyId" to keyId,
        "record" to b64(record.serialize()),
        "publicKey" to b64(keyPair.publicKey.serialize()),
        "signature" to b64(signature),
      )
    }

    AsyncFunction("generateKyberPreKey") { identityKeyPair: String, keyId: Int ->
      val identity = IdentityKeyPair(unb64(identityKeyPair))
      val keyPair = KEMKeyPair.generate(KEMKeyType.KYBER_1024)
      val signature = identity.privateKey.calculateSignature(keyPair.publicKey.serialize())
      val record = KyberPreKeyRecord(keyId, System.currentTimeMillis(), keyPair, signature)
      mapOf(
        "keyId" to keyId,
        "record" to b64(record.serialize()),
        "publicKey" to b64(keyPair.publicKey.serialize()),
        "signature" to b64(signature),
      )
    }

    AsyncFunction("generatePreKeys") { startId: Int, count: Int ->
      (0 until count).map { offset ->
        val keyId = startId + offset
        val record = PreKeyRecord(keyId, ECKeyPair.generate())
        mapOf(
          "keyId" to keyId,
          "record" to b64(record.serialize()),
          "publicKey" to b64(record.keyPair.publicKey.serialize()),
        )
      }
    }

    /**
     * Which local pre-keys an incoming PreKeySignalMessage needs (so JS can load them), and the
     * sender identity key it claims (public; used to report an identity change, never trusted
     * from here).
     */
    AsyncFunction("preKeyMessageInfo") { body: String ->
      val message = PreKeySignalMessage(unb64(body))
      mapOf(
        "preKeyId" to message.preKeyId.orElse(null),
        "signedPreKeyId" to message.signedPreKeyId,
        "identityKey" to b64(message.identityKey.serialize()),
        "registrationId" to message.registrationId,
      )
    }

    /**
     * Security code (Signal "safety number") for two identity public keys, computed by
     * libsignal's NumericFingerprintGenerator. Both phones get the same 60 digits.
     */
    AsyncFunction("securityCode") {
      iterations: Int, version: Int, localName: String, localIdentityKey: String,
      remoteName: String, remoteIdentityKey: String ->
      guard {
        NumericFingerprintGenerator(iterations)
          .createFor(
            version,
            localName.toByteArray(Charsets.UTF_8),
            IdentityKey(unb64(localIdentityKey)),
            remoteName.toByteArray(Charsets.UTF_8),
            IdentityKey(unb64(remoteIdentityKey)),
          )
          .displayableFingerprint.displayText
      }
    }

    /** Builds a new outgoing session from a peer's public pre-key bundle (PQXDH). */
    AsyncFunction("processPreKeyBundle") {
      local: Map<String, Any?>, remote: Map<String, Any?>, bundle: Map<String, Any?> ->
      guard {
        val ctx = Context(local, remote)
        val oneTime = bundle["oneTimePreKey"] as Map<*, *>?
        val signed = bundle["signedPreKey"] as Map<*, *>
        val kyber = bundle["kyberPreKey"] as Map<*, *>
        val preKeyBundle = PreKeyBundle(
          int(bundle["registrationId"]),
          int(bundle["signalDeviceId"]),
          oneTime?.let { int(it["keyId"]) } ?: PreKeyBundle.NULL_PRE_KEY_ID,
          oneTime?.let { ECPublicKey(unb64(it["publicKey"] as String)) },
          int(signed["keyId"]),
          ECPublicKey(unb64(signed["publicKey"] as String)),
          unb64(signed["signature"] as String),
          IdentityKey(unb64(bundle["identityKey"] as String)),
          int(kyber["keyId"]),
          KEMPublicKey(unb64(kyber["publicKey"] as String)),
          unb64(kyber["signature"] as String),
        )
        SessionBuilder(ctx.store, ctx.remoteAddress, ctx.localAddress).process(preKeyBundle)
        ctx.result()
      }
    }

    AsyncFunction("encrypt") { local: Map<String, Any?>, remote: Map<String, Any?>, plaintext: String ->
      guard {
        val ctx = Context(local, remote)
        val message: CiphertextMessage =
          SessionCipher(ctx.store, ctx.localAddress, ctx.remoteAddress).encrypt(unb64(plaintext))
        ctx.result() + mapOf("type" to message.type, "body" to b64(message.serialize()))
      }
    }

    AsyncFunction("decrypt") {
      local: Map<String, Any?>, remote: Map<String, Any?>, input: Map<String, Any?> ->
      guard {
        val ctx = Context(local, remote)
        (input["preKey"] as String?)?.let {
          val record = PreKeyRecord(unb64(it))
          ctx.store.storePreKey(record.id, record)
        }
        (input["signedPreKeys"] as List<*>?)?.forEach {
          val record = SignedPreKeyRecord(unb64(it as String))
          ctx.store.storeSignedPreKey(record.id, record)
        }
        (input["kyberPreKeys"] as List<*>?)?.forEach {
          val record = KyberPreKeyRecord(unb64(it as String))
          ctx.store.storeKyberPreKey(record.id, record)
        }

        val body = unb64(input["body"] as String)
        val cipher = SessionCipher(ctx.store, ctx.localAddress, ctx.remoteAddress)
        var usedPreKeyId: Int? = null
        val plaintext = if (int(input["type"]) == CiphertextMessage.PREKEY_TYPE) {
          val message = PreKeySignalMessage(body)
          usedPreKeyId = message.preKeyId.orElse(null)
          cipher.decrypt(message)
        } else {
          cipher.decrypt(SignalMessage(body))
        }
        ctx.result() + mapOf("plaintext" to b64(plaintext), "usedPreKeyId" to usedPreKeyId)
      }
    }
  }

  /** Per-call in-memory store seeded from the records JS passes in. */
  private class Context(local: Map<String, Any?>, remote: Map<String, Any?>) {
    val store = InMemorySignalProtocolStore(
      IdentityKeyPair(unb64(local["identityKeyPair"] as String)),
      int(local["registrationId"]),
    )
    val localAddress = SignalProtocolAddress(local["name"] as String, int(local["deviceId"]))
    val remoteAddress = SignalProtocolAddress(remote["name"] as String, int(remote["deviceId"]))

    init {
      // Trust on first use: if we already know the peer's identity key, libsignal refuses a
      // different one (UntrustedIdentityException) instead of silently accepting it.
      (remote["identityKey"] as String?)?.let {
        store.saveIdentity(remoteAddress, IdentityKey(unb64(it)))
      }
      (remote["session"] as String?)?.let {
        store.storeSession(remoteAddress, SessionRecord(unb64(it)))
      }
    }

    fun result(): Map<String, Any?> {
      val session = store.loadSession(remoteAddress)
      return mapOf(
        "session" to b64(session.serialize()),
        "remoteIdentityKey" to store.getIdentity(remoteAddress)?.let { b64(it.serialize()) },
        // Which registration of the peer this session talks to (lets the server detect that
        // the peer has since signed in again with new keys).
        "remoteRegistrationId" to runCatching { session.remoteRegistrationId }.getOrNull(),
      )
    }
  }

  private inline fun <T> guard(block: () -> T): T =
    try {
      block()
    } catch (e: UntrustedIdentityException) {
      throw CodedException("UNTRUSTED_IDENTITY", "Peer identity key changed", e)
    } catch (e: DuplicateMessageException) {
      throw CodedException("DUPLICATE_MESSAGE", "Message already processed", e)
    } catch (e: NoSessionException) {
      throw CodedException("NO_SESSION", "No session with this peer", e)
    } catch (e: InvalidKeyIdException) {
      throw CodedException("MISSING_PREKEY", "Referenced pre-key not found", e)
    } catch (e: CodedException) {
      throw e
    } catch (e: Exception) {
      throw CodedException("SIGNAL_ERROR", e.javaClass.simpleName, e)
    }

  private companion object {
    fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
    fun unb64(text: String): ByteArray = Base64.decode(text, Base64.NO_WRAP)
    fun int(value: Any?): Int = (value as Number).toInt()
  }
}
