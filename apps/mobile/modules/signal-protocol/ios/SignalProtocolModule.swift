import ExpoModulesCore
import Foundation
import LibSignalClient

/**
 Thin, stateless bridge to the official libsignal (LibSignalClient, the same v0.105.0 release as
 org.signal:libsignal-android used by the Android bridge).

 No cryptography is implemented here: every operation calls libsignal. State (identity key pair,
 sessions, pre-keys) is persisted by JS in the SQLCipher database / SecureStore; each call
 receives the records it needs, runs libsignal against an in-memory store, and returns the
 updated records for JS to save. All binary values cross the bridge as standard base64.

 The contract (function names, argument shapes, result keys, error codes) is identical to
 android/.../SignalProtocolModule.kt; test/nativeParity.test.js checks that mechanically.
 */
public class SignalProtocolModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SignalProtocol")

    AsyncFunction("generateIdentity") { () -> [String: Any] in
      let identity = IdentityKeyPair.generate()
      return [
        "identityKeyPair": b64(identity.serialize()),
        "identityKey": b64(identity.publicKey.serialize()),
        // Same range as Android's KeyHelper.generateRegistrationId(false). Swift's default
        // random generator is the system CSPRNG.
        "registrationId": Int(UInt32.random(in: 1...16380)),
      ]
    }

    AsyncFunction("generateSignedPreKey") { (identityKeyPair: String, keyId: Int) -> [String: Any] in
      try guarded {
        let identity = try IdentityKeyPair(bytes: unb64(identityKeyPair))
        let keyPair = PrivateKey.generate()
        let signature = identity.privateKey.generateSignature(message: keyPair.publicKey.serialize())
        let record = try SignedPreKeyRecord(
          id: UInt32(keyId),
          timestamp: UInt64(Date().timeIntervalSince1970 * 1000),
          privateKey: keyPair,
          signature: signature
        )
        return [
          "keyId": keyId,
          "record": b64(record.serialize()),
          "publicKey": b64(keyPair.publicKey.serialize()),
          "signature": b64(signature),
        ]
      }
    }

    AsyncFunction("generateKyberPreKey") { (identityKeyPair: String, keyId: Int) -> [String: Any] in
      try guarded {
        let identity = try IdentityKeyPair(bytes: unb64(identityKeyPair))
        let keyPair = KEMKeyPair.generate()
        let signature = identity.privateKey.generateSignature(message: keyPair.publicKey.serialize())
        let record = try KyberPreKeyRecord(
          id: UInt32(keyId),
          timestamp: UInt64(Date().timeIntervalSince1970 * 1000),
          keyPair: keyPair,
          signature: signature
        )
        return [
          "keyId": keyId,
          "record": b64(record.serialize()),
          "publicKey": b64(keyPair.publicKey.serialize()),
          "signature": b64(signature),
        ]
      }
    }

    AsyncFunction("generatePreKeys") { (startId: Int, count: Int) -> [[String: Any]] in
      try guarded {
        try (0..<count).map { offset in
          let keyId = startId + offset
          let record = try PreKeyRecord(id: UInt32(keyId), privateKey: PrivateKey.generate())
          return [
            "keyId": keyId,
            "record": b64(record.serialize()),
            "publicKey": b64(try record.publicKey().serialize()),
          ]
        }
      }
    }

    /**
     Which local pre-keys an incoming PreKeySignalMessage needs (so JS can load them), and the
     sender identity key it claims (public; used to report an identity change, never trusted
     from here).
     */
    AsyncFunction("preKeyMessageInfo") { (body: String) -> [String: Any?] in
      try guarded {
        let message = try PreKeySignalMessage(bytes: unb64(body))
        return [
          "preKeyId": try message.preKeyId().map { Int($0) },
          "signedPreKeyId": Int(message.signedPreKeyId),
          "identityKey": b64(message.identityKey.serialize()),
          "registrationId": Int(try message.registrationId()),
        ]
      }
    }

    /**
     Security code (Signal "safety number") for two identity public keys, computed by
     libsignal's NumericFingerprintGenerator. Both phones get the same 60 digits. The formatted
     string is digits with spaces; JS matches digit groups, so spaces are stripped here to be
     byte-identical with the Android bridge's displayText.
     */
    AsyncFunction("securityCode") {
      (iterations: Int, version: Int, localName: String, localIdentityKey: String,
       remoteName: String, remoteIdentityKey: String) -> String in
      try guarded {
        let fingerprint = try NumericFingerprintGenerator(iterations: iterations).create(
          version: version,
          localIdentifier: Data(localName.utf8),
          localKey: try PublicKey(unb64(localIdentityKey)),
          remoteIdentifier: Data(remoteName.utf8),
          remoteKey: try PublicKey(unb64(remoteIdentityKey))
        )
        return fingerprint.displayable.formatted.filter { $0.isNumber }
      }
    }

    /** Builds a new outgoing session from a peer's public pre-key bundle (PQXDH). */
    AsyncFunction("processPreKeyBundle") {
      (local: [String: Any], remote: [String: Any], bundle: [String: Any]) -> [String: Any?] in
      try guarded {
        let ctx = try Context(local: local, remote: remote)
        let signed = try dict(bundle["signedPreKey"])
        let kyber = try dict(bundle["kyberPreKey"])
        let identityKey = try IdentityKey(bytes: unb64(str(bundle["identityKey"])))

        let preKeyBundle: PreKeyBundle
        if let oneTime = bundle["oneTimePreKey"] as? [String: Any] {
          preKeyBundle = try PreKeyBundle(
            registrationId: try uint32(bundle["registrationId"]),
            deviceId: try uint32(bundle["signalDeviceId"]),
            prekeyId: try uint32(oneTime["keyId"]),
            prekey: try PublicKey(unb64(str(oneTime["publicKey"]))),
            signedPrekeyId: try uint32(signed["keyId"]),
            signedPrekey: try PublicKey(unb64(str(signed["publicKey"]))),
            signedPrekeySignature: try unb64(str(signed["signature"])),
            identity: identityKey,
            kyberPrekeyId: try uint32(kyber["keyId"]),
            kyberPrekey: try KEMPublicKey(unb64(str(kyber["publicKey"]))),
            kyberPrekeySignature: try unb64(str(kyber["signature"]))
          )
        } else {
          preKeyBundle = try PreKeyBundle(
            registrationId: try uint32(bundle["registrationId"]),
            deviceId: try uint32(bundle["signalDeviceId"]),
            signedPrekeyId: try uint32(signed["keyId"]),
            signedPrekey: try PublicKey(unb64(str(signed["publicKey"]))),
            signedPrekeySignature: try unb64(str(signed["signature"])),
            identity: identityKey,
            kyberPrekeyId: try uint32(kyber["keyId"]),
            kyberPrekey: try KEMPublicKey(unb64(str(kyber["publicKey"]))),
            kyberPrekeySignature: try unb64(str(kyber["signature"]))
          )
        }

        try processPreKeyBundle(
          preKeyBundle,
          for: ctx.remoteAddress,
          ourAddress: ctx.localAddress,
          sessionStore: ctx.store,
          identityStore: ctx.store,
          context: NullContext()
        )
        return try ctx.result()
      }
    }

    AsyncFunction("encrypt") {
      (local: [String: Any], remote: [String: Any], plaintext: String) -> [String: Any?] in
      try guarded {
        let ctx = try Context(local: local, remote: remote)
        let message = try signalEncrypt(
          message: unb64(plaintext),
          for: ctx.remoteAddress,
          localAddress: ctx.localAddress,
          sessionStore: ctx.store,
          identityStore: ctx.store,
          context: NullContext()
        )
        var result = try ctx.result()
        result["type"] = Int(message.messageType.rawValue)
        result["body"] = b64(message.serialize())
        return result
      }
    }

    AsyncFunction("decrypt") {
      (local: [String: Any], remote: [String: Any], input: [String: Any]) -> [String: Any?] in
      try guarded {
        let ctx = try Context(local: local, remote: remote)
        if let preKey = input["preKey"] as? String {
          let record = try PreKeyRecord(bytes: unb64(preKey))
          try ctx.store.storePreKey(record, id: record.id, context: NullContext())
        }
        for raw in (input["signedPreKeys"] as? [String]) ?? [] {
          let record = try SignedPreKeyRecord(bytes: unb64(raw))
          try ctx.store.storeSignedPreKey(record, id: record.id, context: NullContext())
        }
        for raw in (input["kyberPreKeys"] as? [String]) ?? [] {
          let record = try KyberPreKeyRecord(bytes: unb64(raw))
          try ctx.store.storeKyberPreKey(record, id: record.id, context: NullContext())
        }

        let body = try unb64(str(input["body"]))
        var usedPreKeyId: Int? = nil
        let plaintext: Data
        if try uint32(input["type"]) == UInt32(CiphertextMessage.MessageType.preKey.rawValue) {
          let message = try PreKeySignalMessage(bytes: body)
          usedPreKeyId = try message.preKeyId().map { Int($0) }
          plaintext = try signalDecryptPreKey(
            message: message,
            from: ctx.remoteAddress,
            localAddress: ctx.localAddress,
            sessionStore: ctx.store,
            identityStore: ctx.store,
            preKeyStore: ctx.store,
            signedPreKeyStore: ctx.store,
            kyberPreKeyStore: ctx.store,
            context: NullContext()
          )
        } else {
          plaintext = try signalDecrypt(
            message: try SignalMessage(bytes: body),
            from: ctx.remoteAddress,
            to: ctx.localAddress,
            sessionStore: ctx.store,
            identityStore: ctx.store,
            context: NullContext()
          )
        }
        var result = try ctx.result()
        result["plaintext"] = b64(plaintext)
        result["usedPreKeyId"] = usedPreKeyId
        return result
      }
    }
  }
}

/** Per-call in-memory store seeded from the records JS passes in (mirrors Context in Kotlin). */
private final class Context {
  let store: InMemorySignalProtocolStore
  let localAddress: ProtocolAddress
  let remoteAddress: ProtocolAddress

  init(local: [String: Any], remote: [String: Any]) throws {
    let identity = try IdentityKeyPair(bytes: unb64(str(local["identityKeyPair"])))
    store = InMemorySignalProtocolStore(identity: identity, registrationId: try uint32(local["registrationId"]))
    localAddress = try ProtocolAddress(name: str(local["name"]), deviceId: try uint32(local["deviceId"]))
    remoteAddress = try ProtocolAddress(name: str(remote["name"]), deviceId: try uint32(remote["deviceId"]))

    // Trust on first use: if we already know the peer's identity key, libsignal refuses a
    // different one (SignalError.untrustedIdentity) instead of silently accepting it.
    if let identityKey = remote["identityKey"] as? String {
      _ = try store.saveIdentity(
        IdentityKey(bytes: unb64(identityKey)),
        for: remoteAddress,
        context: NullContext()
      )
    }
    if let session = remote["session"] as? String {
      try store.storeSession(
        SessionRecord(bytes: unb64(session)),
        for: remoteAddress,
        context: NullContext()
      )
    }
  }

  func result() throws -> [String: Any?] {
    let session = try store.loadSession(for: remoteAddress, context: NullContext())
    let identity = try store.identity(for: remoteAddress, context: NullContext())
    return [
      "session": session.map { b64($0.serialize()) },
      "remoteIdentityKey": identity.map { b64($0.serialize()) },
      // Which registration of the peer this session talks to (lets the server detect that
      // the peer has since signed in again with new keys).
      "remoteRegistrationId": session.flatMap { try? Int($0.remoteRegistrationId()) },
    ]
  }
}

/** Same stable error codes as the Android bridge's CodedExceptions. */
private struct SignalBridgeError: Error, CodedError {
  let code: String
  let description: String
}

private func guarded<T>(_ block: () throws -> T) throws -> T {
  do {
    return try block()
  } catch let error as SignalBridgeError {
    throw error
  } catch SignalError.untrustedIdentity {
    throw SignalBridgeError(code: "UNTRUSTED_IDENTITY", description: "Peer identity key changed")
  } catch SignalError.duplicatedMessage {
    throw SignalBridgeError(code: "DUPLICATE_MESSAGE", description: "Message already processed")
  } catch SignalError.sessionNotFound {
    throw SignalBridgeError(code: "NO_SESSION", description: "No session with this peer")
  } catch SignalError.invalidKeyIdentifier {
    throw SignalBridgeError(code: "MISSING_PREKEY", description: "Referenced pre-key not found")
  } catch {
    throw SignalBridgeError(code: "SIGNAL_ERROR", description: String(describing: type(of: error)))
  }
}

private func b64(_ data: Data) -> String {
  data.base64EncodedString()
}

private func unb64(_ text: String) throws -> Data {
  guard let data = Data(base64Encoded: text) else {
    throw SignalBridgeError(code: "SIGNAL_ERROR", description: "Invalid base64 input")
  }
  return data
}

private func str(_ value: Any?) throws -> String {
  guard let string = value as? String else {
    throw SignalBridgeError(code: "SIGNAL_ERROR", description: "Expected a string argument")
  }
  return string
}

private func dict(_ value: Any?) throws -> [String: Any] {
  guard let dictionary = value as? [String: Any] else {
    throw SignalBridgeError(code: "SIGNAL_ERROR", description: "Expected an object argument")
  }
  return dictionary
}

private func uint32(_ value: Any?) throws -> UInt32 {
  if let number = value as? Int, number >= 0 { return UInt32(number) }
  if let number = value as? UInt32 { return number }
  if let number = value as? Double, number >= 0 { return UInt32(number) }
  throw SignalBridgeError(code: "SIGNAL_ERROR", description: "Expected a non-negative integer")
}
