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
  /** Max message ids in one read-receipt or status request. */
  MESSAGE_BATCH_MAX: 100,
  /** Max phone numbers in one contact-discovery request (clients send larger books in batches). */
  CONTACT_MATCH_BATCH_MAX: 500,
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
});

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
