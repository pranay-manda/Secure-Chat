/**
 * Constants shared by the API and the mobile app.
 * Keep this file free of runtime dependencies so it loads in Node and Metro alike.
 */

export const API_VERSION = 'v1';

/** Request/response header names. */
export const HEADERS = Object.freeze({
  REQUEST_ID: 'x-request-id',
  DEVICE_ID: 'x-device-id',
  IDEMPOTENCY_KEY: 'idempotency-key',
});

/** Overall and per-dependency health states reported by GET /health. */
export const HEALTH_STATUS = Object.freeze({
  OK: 'ok',
  DEGRADED: 'degraded',
  DOWN: 'down',
});

export const LIMITS = Object.freeze({
  /** Max JSON request body accepted by the API. */
  JSON_BODY_BYTES: 100 * 1024,
  /**
   * Pusher rejects events over 10 KB. Envelopes larger than this are not sent inline;
   * the event carries only { messageId, seq } and the client fetches over HTTPS.
   */
  PUSHER_INLINE_PAYLOAD_BYTES: 8 * 1024,
  /**
   * Pusher's limit for one event. The API refuses to relay a call signal that would exceed it
   * (413) rather than have Pusher drop it silently.
   */
  PUSHER_EVENT_MAX_BYTES: 10 * 1024,
  /** Max message ids in one read-receipt or status request. */
  MESSAGE_BATCH_MAX: 100,
  /** Max phone numbers in one contact-discovery request (clients send larger books in batches). */
  CONTACT_MATCH_BATCH_MAX: 500,
  /** Max user ids in one GET /contacts/peers request (phone numbers of people who wrote to us). */
  CONTACT_PEERS_MAX: 50,
  /** Max items returned by one page of a cursor-paginated endpoint. */
  PAGE_SIZE_MAX: 100,
  PAGE_SIZE_DEFAULT: 50,
});

/**
 * Pusher channel prefixes (names only; Pusher is wired up in Phase 5).
 * `private-` / `presence-` prefixes are required by Pusher for authorized channels.
 */
export const CHANNEL_PREFIX = Object.freeze({
  DEVICE: 'private-device-',
  CHAT: 'private-chat-',
  PRESENCE_CHAT: 'presence-chat-',
  CALL: 'private-call-',
});

export const OTP_LENGTH = 6;

/** How a sign-in code is delivered; each channel identifies the account by its own field. */
export const OTP_CHANNEL = Object.freeze({
  EMAIL: 'email',
  PHONE: 'phone',
});

export const DEVICE_PLATFORM = Object.freeze({
  IOS: 'ios',
  ANDROID: 'android',
});

/** Stable error codes returned in `{ error: { code } }`; clients branch on these, not messages. */
export const ERROR_CODE = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  OTP_COOLDOWN: 'OTP_COOLDOWN',
  OTP_INVALID: 'OTP_INVALID',
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  OTP_DELIVERY_FAILED: 'OTP_DELIVERY_FAILED',
  OTP_CHANNEL_UNAVAILABLE: 'OTP_CHANNEL_UNAVAILABLE',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  KEYS_NOT_REGISTERED: 'KEYS_NOT_REGISTERED',
  IDENTITY_KEY_CONFLICT: 'IDENTITY_KEY_CONFLICT',
  PREKEY_LIMIT_EXCEEDED: 'PREKEY_LIMIT_EXCEEDED',
  STALE_RECIPIENT_DEVICE: 'STALE_RECIPIENT_DEVICE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  // Voice calls
  CALL_NOT_FOUND: 'CALL_NOT_FOUND',
  CALL_ENDED: 'CALL_ENDED',
  CALL_INVALID_STATE: 'CALL_INVALID_STATE',
  CALLEE_BUSY: 'CALLEE_BUSY',
  CALLEE_UNAVAILABLE: 'CALLEE_UNAVAILABLE',
  ALREADY_IN_CALL: 'ALREADY_IN_CALL',
  // Account details (email + phone both required)
  PHONE_NUMBER_REQUIRED: 'PHONE_NUMBER_REQUIRED',
  PHONE_NUMBER_TAKEN: 'PHONE_NUMBER_TAKEN',
  PHONE_NUMBER_MISMATCH: 'PHONE_NUMBER_MISMATCH',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  ALREADY_SET: 'ALREADY_SET',
  // Attachments (encrypted media)
  ATTACHMENT_NOT_FOUND: 'ATTACHMENT_NOT_FOUND',
  ATTACHMENT_INCOMPLETE: 'ATTACHMENT_INCOMPLETE',
});

/**
 * Encrypted attachments (photos, videos, voice notes). The phone encrypts each file with its own
 * random AES-256-GCM key before upload; the server and storage only ever hold the encrypted
 * blob, and the key travels inside the Signal message.
 *
 *   blob = nonce (12 bytes) || AES-256-GCM(key, nonce, padded plaintext) || tag (16 bytes)
 *
 * The plaintext is zero-padded to `paddedAttachmentSize(size)` so the server learns only a size
 * bucket, not the exact file size. The real size is in the Signal message.
 */
export const ATTACHMENT = Object.freeze({
  /** Largest file (plaintext bytes) the app sends. */
  MAX_BYTES: 100 * 1024 * 1024,
  KEY_BYTES: 32,
  NONCE_BYTES: 12,
  TAG_BYTES: 16,
  DIGEST_BYTES: 32,
  /** Nonce + tag around the padded plaintext. */
  OVERHEAD_BYTES: 12 + 16,
  /** Every plaintext is padded to at least this many bytes. */
  MIN_PADDED_BYTES: 1024,
  /** Lifetime of a signed upload or download URL (checked when the transfer starts). */
  TRANSFER_URL_TTL_SECONDS: 15 * 60,
  /** Longest voice note. */
  VOICE_NOTE_MAX_MS: 15 * 60 * 1000,
});

/**
 * Padded plaintext size: 16 buckets per power of two (at most 6.25 % larger), at least
 * MIN_PADDED_BYTES. Integer-only arithmetic, so every platform computes the same value.
 */
export function paddedAttachmentSize(size) {
  if (!Number.isInteger(size) || size < 0) throw new RangeError('Invalid attachment size');
  if (size <= ATTACHMENT.MIN_PADDED_BYTES) return ATTACHMENT.MIN_PADDED_BYTES;
  const exponent = 31 - Math.clz32(size); // floor(log2(size))
  const step = 2 ** (exponent - 4);
  return Math.ceil(size / step) * step;
}

/** Size of the encrypted blob for a plaintext of `size` bytes. */
export function encryptedAttachmentSize(size) {
  return paddedAttachmentSize(size) + ATTACHMENT.OVERHEAD_BYTES;
}

/** Largest encrypted blob the API accepts. */
export const ATTACHMENT_MAX_ENCRYPTED_BYTES = encryptedAttachmentSize(ATTACHMENT.MAX_BYTES);

/**
 * Signal Protocol parameters (libsignal 0.105). The server only ever handles PUBLIC keys and
 * opaque ciphertext; all key generation, signing, encryption and decryption happen on devices.
 */
export const SIGNAL = Object.freeze({
  /** v1 is single-device: every user's Signal address is (userId, 1). */
  DEFAULT_DEVICE_ID: 1,
  /** One-time EC pre-keys uploaded per batch, and the server-side cap per device. */
  ONE_TIME_PREKEY_BATCH: 100,
  ONE_TIME_PREKEY_MAX_STORED: 200,
  /** Client replenishes when the server reports fewer than this many remaining. */
  ONE_TIME_PREKEY_LOW_WATERMARK: 20,
  /** Serialized sizes in bytes (type byte + key material). */
  EC_PUBLIC_KEY_BYTES: 33,
  KYBER_1024_PUBLIC_KEY_BYTES: 1569,
  SIGNATURE_BYTES: 64,
  /** Pre-key ids are 24-bit (Signal's Medium.MAX_VALUE). */
  MAX_KEY_ID: 0xffffff,
  MAX_REGISTRATION_ID: 16380,
  /** Upper bound for one encrypted envelope (text messages are far smaller). */
  MAX_CIPHERTEXT_BYTES: 64 * 1024,
  /**
   * Security code (libsignal NumericFingerprintGenerator): hash iterations and format version.
   * Both phones must use the same values to show the same 60-digit code.
   */
  SECURITY_CODE_ITERATIONS: 5200,
  SECURITY_CODE_VERSION: 2,
  /** The signed (EC) and Kyber last-resort pre-keys are replaced this often. */
  SIGNED_PREKEY_ROTATION_MS: 7 * 24 * 60 * 60 * 1000,
  /**
   * A replaced signed/Kyber pre-key (private half) is kept this long after its replacement, so
   * a first message encrypted to it can still be decrypted when it arrives. Longer than the
   * server's undelivered-envelope retention (30 days), then deleted for forward secrecy.
   */
  SIGNED_PREKEY_RETENTION_MS: 35 * 24 * 60 * 60 * 1000,
});

/** libsignal CiphertextMessage types carried in envelopes. */
export const CIPHERTEXT_TYPE = Object.freeze({
  WHISPER: 2, // SignalMessage: an established session
  PREKEY: 3, // PreKeySignalMessage: first message(s) of a new session
});

/** Realtime events (Pusher). Payloads carry ciphertext or ids only, never plaintext. */
export const REALTIME_EVENT = Object.freeze({
  ENVELOPE: 'envelope',
  /** To the sender's device: `{ receipts: [{ messageId, status, at }] }`. */
  RECEIPT: 'receipt',
  /** Voice-call signaling to one participant's device: `{ type: CALL_EVENT.*, callId, ... }`. */
  CALL: 'call',
  /**
   * Online status changed, to the devices of people the user has a chat with:
   * `{ userId, online }` (no time, no device). Sent when the user's app comes online and when it
   * goes away on purpose; a vanished connection is noticed by polling after the server TTL.
   */
  PRESENCE: 'presence',
  /** Typing indicator to a peer's device: `{ fromUserId, typing }`. */
  TYPING: 'typing',
});

/**
 * Voice calls (1:1). Pusher carries ONLY signaling (who/what/state, SDP, ICE candidates);
 * audio flows directly between the two phones over WebRTC (DTLS-SRTP), never via the server.
 * Call media security is WebRTC's, separate from the Signal Protocol used for messages.
 */
/**
 * Online status = "the app on this user's active device recently reached the API", not human
 * availability. A device sends a heartbeat every HEARTBEAT_INTERVAL_SECONDS while the app is on
 * screen and online; the server forgets it after TTL_SECONDS without one (two missed beats).
 */
export const PRESENCE = Object.freeze({
  HEARTBEAT_INTERVAL_SECONDS: 20,
  TTL_SECONDS: 45,
  /** User ids per presence query. */
  QUERY_MAX_IDS: 50,
});

export const CALL_KIND = Object.freeze({ VOICE: 'voice', VIDEO: 'video' });
export const CALL_KINDS = Object.freeze([CALL_KIND.VOICE, CALL_KIND.VIDEO]);

export const CALL_EVENT = Object.freeze({
  /** To the callee: `{ callId, callerUserId, kind, createdAt, ringExpiresAt }`. */
  INVITE: 'invite',
  /** To the caller: the callee answered; start WebRTC negotiation. */
  ACCEPTED: 'accepted',
  /**
   * To the other participant: `{ kind: 'offer'|'answer'|'candidates'|'media'|'attest', ... }`.
   * `media` carries `{ video: boolean }`: whether the sender's camera is on (no media itself).
   * `attest` carries `{ attestation: { type, body }, senderDeviceId }`: the sender's DTLS
   * fingerprints as Signal ciphertext (opaque to the server).
   */
  SIGNAL: 'signal',
  /** To one or both participants: `{ status, reason }` (terminal). */
  ENDED: 'ended',
});

/** Server-side call states. Media states (connecting/connected) exist only on the phones. */
export const CALL_STATUS = Object.freeze({
  RINGING: 'ringing',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  MISSED: 'missed',
  ENDED: 'ended',
  FAILED: 'failed',
});

export const CALL_TERMINAL_STATUSES = Object.freeze([
  CALL_STATUS.REJECTED,
  CALL_STATUS.CANCELLED,
  CALL_STATUS.MISSED,
  CALL_STATUS.ENDED,
  CALL_STATUS.FAILED,
]);

/** Size limits for signaling relayed through Pusher (whole event must stay under 10 KB). */
export const CALL_LIMITS = Object.freeze({
  SDP_MAX_CHARS: 8000,
  CANDIDATES_PER_REQUEST: 20,
  CANDIDATE_MAX_CHARS: 512,
  /**
   * Remote ICE candidates a phone accepts per ICE generation (one offer/answer exchange: the
   * first, then each ICE restart) and per call in total; more is a flood and is ignored. A real
   * exchange brings a handful; per generation, so a long call with many network switches
   * (each restart brings new candidates) does not run out.
   */
  CANDIDATES_PER_GENERATION: 100,
  CANDIDATES_PER_CALL: 300,
  /** Highest ICE-restart number an offer may carry (each restart offer is numbered). */
  ICE_RESTARTS_MAX: 1000,
  /**
   * Signal ciphertext of one call-security attestation (decoded bytes). A first-contact
   * pre-key message measured 2,049 bytes (event 2,848 B); 3,072 leaves room and keeps the
   * event far under Pusher's limit.
   */
  ATTESTATION_MAX_BYTES: 3 * 1024,
  /** Missed-call notes kept per user until their phone collects them (and ids per ack). */
  MISSED_MAX: 100,
});

/**
 * Server-side message states (metadata only, derived from acks, never from content).
 * sent = persisted; delivered = recipient device processed the envelope; read = opened.
 */
export const MESSAGE_STATUS = Object.freeze({
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
});

export const CHAT_TYPE = Object.freeze({
  DIRECT: 'direct',
  GROUP: 'group',
});
