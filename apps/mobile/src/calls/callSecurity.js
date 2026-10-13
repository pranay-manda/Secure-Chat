import { CALL_LIMITS, CIPHERTEXT_TYPE } from '@secure-chat/shared/constants';

import { base64ToBytes, bytesToBase64 } from '../crypto/encoding';
import { CANONICAL_FINGERPRINT, CONTENT_TYPE } from '../messaging/content';

/**
 * Call security (R2): authenticating each call's DTLS-SRTP keys through Signal.
 *
 * libwebrtc accepts the other phone's DTLS certificate only if it matches an `a=fingerprint`
 * of the remote description, so whoever can change that description (our server, Pusher)
 * could otherwise put themselves in the middle of the call. Each phone therefore tells the
 * other its own fingerprints in an attestation (`call.dtls`, messaging/content.js): bound to the
 * call, its direction, both users and the call kind, Signal-encrypted on the regular session
 * with the other person, and relayed as an `attest` signal. A remote description is applied
 * only if its fingerprint set is exactly the attested one.
 *
 * Who an attestation is from is proven by the Signal session that decrypts it (the peer's
 * trusted identity key), never by anything the server says. This file holds the pure parts;
 * callEngine.js holds the protocol, crypto/signalService.js the Signal sealing.
 */

/** The only fingerprint algorithm accepted (the one libwebrtc uses for its certificates). */
export const FINGERPRINT_ALGORITHMS = Object.freeze(['sha-256']);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SDP_FINGERPRINT = /^a=fingerprint:([A-Za-z0-9-]+) ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})*)$/;

/**
 * The DTLS fingerprint set of an SDP description: every `a=fingerprint` line (session or media
 * level) in canonical form (`sha-256 AB:…`), without repeats, sorted. Strict: one malformed
 * line, an algorithm other than SHA-256 or a wrong length rejects the whole description, and
 * so does a description without any fingerprint.
 *
 * @returns {{ ok: true, fingerprints: string[] } | { ok: false, reason: string }}
 */
export function parseFingerprints(sdp) {
  if (typeof sdp !== 'string') return { ok: false, reason: 'no_description' };
  const found = new Set();
  for (const line of sdp.split(/\r?\n/)) {
    if (!/^a=fingerprint/i.test(line)) continue;
    const match = SDP_FINGERPRINT.exec(line);
    if (!match) return { ok: false, reason: 'malformed' };
    const canonical = `${match[1].toLowerCase()} ${match[2].toUpperCase()}`;
    if (!CANONICAL_FINGERPRINT.test(canonical)) return { ok: false, reason: 'algorithm' };
    found.add(canonical);
  }
  if (found.size === 0) return { ok: false, reason: 'missing' };
  return { ok: true, fingerprints: [...found].sort() };
}

/** Exactly the same fingerprint set (both canonical and sorted, as produced above). */
export const sameFingerprints = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((value, i) => value === b[i]);

/** This phone's attestation for a call (content to seal; see messaging/content.js). */
export const attestationContent = ({ callId, role, from, to, kind, fingerprints }) => ({
  type: CONTENT_TYPE.CALL_DTLS,
  version: 1,
  callId,
  role,
  from,
  to,
  kind,
  fingerprints,
});

/**
 * Checks a decrypted attestation against the call it has to belong to. The Signal session
 * that decrypted it already proved which person sent it; this binds it to this call, this
 * direction, these two people and this kind of call.
 *
 * @param {object} decoded decodeContent() result of the decrypted plaintext
 * @param {{ callId: string, role: 'caller'|'callee', from: string, to: string, kind: string }} expected
 * @returns {{ ok: true, fingerprints: string[] } | { ok: false, reason: string }}
 */
export function verifyAttestation(decoded, expected) {
  if (!decoded?.ok || !decoded.internal) return { ok: false, reason: 'content' };
  const content = decoded.content;
  if (content.type !== CONTENT_TYPE.CALL_DTLS || content.version !== 1) {
    return { ok: false, reason: 'type' };
  }
  if (content.callId !== expected.callId) return { ok: false, reason: 'call' };
  if (content.role !== expected.role) return { ok: false, reason: 'role' };
  if (content.from !== expected.from || content.to !== expected.to) {
    return { ok: false, reason: 'peer' };
  }
  if (content.kind !== expected.kind) return { ok: false, reason: 'kind' };
  const fingerprints = [...content.fingerprints].sort();
  const approved = fingerprints.every(
    (value) =>
      CANONICAL_FINGERPRINT.test(value) && FINGERPRINT_ALGORITHMS.includes(value.split(' ')[0]),
  );
  if (!approved || new Set(fingerprints).size !== fingerprints.length) {
    return { ok: false, reason: 'fingerprints' };
  }
  return { ok: true, fingerprints };
}

/**
 * A received attestation's Signal ciphertext in canonical form (its bytes, re-encoded), or null
 * if it is not well-formed. The canonical body identifies one ciphertext however it was
 * encoded on the way, so a copy of one already verified is recognised without decrypting.
 *
 * @returns {{ type: number, body: string } | null}
 */
export function canonicalCiphertext(attestation) {
  const type = attestation?.type;
  const body = attestation?.body;
  if (type !== CIPHERTEXT_TYPE.WHISPER && type !== CIPHERTEXT_TYPE.PREKEY) return null;
  if (typeof body !== 'string' || body.length === 0 || !BASE64.test(body)) return null;
  let bytes;
  try {
    bytes = base64ToBytes(body);
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > CALL_LIMITS.ATTESTATION_MAX_BYTES) return null;
  return { type, body: bytesToBase64(bytes) };
}
