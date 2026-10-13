import { ATTACHMENT, CALL_KINDS, SIGNAL } from '@secure-chat/shared/constants';
import { base64Bytes, objectIdSchema } from '@secure-chat/shared/validation';
import { z } from 'zod';

import { WAVEFORM_PATTERN } from '../media/waveform';

/**
 * What goes inside a Signal message: the plaintext that libsignal encrypts, only ever seen by
 * the two phones. Versioned, typed content (since R1):
 *
 *   byte 0     CONTENT_MARKER (0xFF)
 *   bytes 1..  UTF-8 JSON object: { "type": <string>, "version": <integer>, ...fields }
 *
 *   text        v1  { text }                          a chat message
 *   attachment  v1  { id, key, digest, size, ... }    a photo, video or voice note (encrypted file)
 *   call.dtls   v1  { callId, role, from, to, ... }   internal: a call's DTLS fingerprints (R2)
 *
 * Earlier app versions put the raw UTF-8 text in the message. 0xFF never occurs in UTF-8, so a
 * plaintext without the marker is always such legacy text: it is shown as text, exactly as
 * before, and can never be read as typed content (e.g. an internal control message).
 *
 * A type containing a dot (`<area>.<name>`, e.g. `call.dtls`) is internal: whatever its version
 * and even if malformed, it never becomes a chat message, so a control type added later is
 * dropped by this version instead of being shown. An unknown chat type or version is reported
 * as unsupported and malformed content as invalid; the chat shows a placeholder for both, never
 * raw JSON. Every field is checked strictly (required fields, types, sizes, no unknown fields):
 * a later revision that adds a field is a new version.
 */

/** First byte of versioned content; never the first byte of UTF-8 text. */
export const CONTENT_MARKER = 0xff;

export const CONTENT_TYPE = Object.freeze({
  TEXT: 'text',
  ATTACHMENT: 'attachment',
  CALL_DTLS: 'call.dtls',
});

export const CONTENT_LIMITS = Object.freeze({
  /**
   * Whole encoded content (marker + JSON), checked before parsing. Leaves 16 KiB for Signal's
   * own overhead (a first message carries a Kyber ciphertext) under the server's ciphertext cap.
   */
  MAX_BYTES: SIGNAL.MAX_CIPHERTEXT_BYTES - 16 * 1024,
  /** Text and captions, in UTF-16 code units (the chat input allows 4,000). */
  TEXT_MAX_LENGTH: 16_000,
  /** Attachments: largest file (plaintext bytes) and file name. */
  ATTACHMENT_MAX_BYTES: ATTACHMENT.MAX_BYTES,
  FILE_NAME_MAX_LENGTH: 255,
  /** Call attestations: certificate fingerprints per participant (a phone has one). */
  FINGERPRINTS_MAX: 4,
});

export const CONTENT_ERROR = Object.freeze({
  INVALID: 'CONTENT_INVALID',
  TOO_LARGE: 'CONTENT_TOO_LARGE',
});

export class ContentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContentError';
    this.code = code;
  }
}

/** Internal (control) content: never shown as a chat message. */
export const isInternalType = (type) => type.includes('.');

const text = z.string().min(1).max(CONTENT_LIMITS.TEXT_MAX_LENGTH);
const dimension = z.number().int().min(1).max(65_535);

/**
 * A DTLS certificate fingerprint in canonical form: `sha-256` and 32 upper-case hex bytes
 * (`a=fingerprint` in SDP, which is what libwebrtc produces). SHA-256 is the only approved
 * algorithm; anything else is not a fingerprint here.
 */
export const CANONICAL_FINGERPRINT = /^sha-256 [0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;
const fingerprint = z.string().regex(CANONICAL_FINGERPRINT);

/** type -> version -> schema. Maps, so names like "constructor" never resolve to anything. */
const SCHEMAS = new Map([
  [
    CONTENT_TYPE.TEXT,
    new Map([
      [1, z.strictObject({ type: z.literal(CONTENT_TYPE.TEXT), version: z.literal(1), text })],
    ]),
  ],
  [
    CONTENT_TYPE.ATTACHMENT,
    new Map([
      [
        1,
        // A photo, video or voice note. The file itself is encrypted on the phone with `key`
        // (AES-256-GCM, see modules/media-crypto) and uploaded as an opaque blob; this message
        // carries what the recipient needs to fetch, verify and decrypt it. `id` is the
        // server's attachment id, `digest` the SHA-256 of the encrypted blob, `size` the real
        // (unpadded) plaintext size.
        z.strictObject({
          type: z.literal(CONTENT_TYPE.ATTACHMENT),
          version: z.literal(1),
          id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
          key: base64Bytes({ bytes: ATTACHMENT.KEY_BYTES }),
          digest: base64Bytes({ bytes: ATTACHMENT.DIGEST_BYTES }),
          size: z.number().int().min(1).max(CONTENT_LIMITS.ATTACHMENT_MAX_BYTES),
          contentType: z
            .string()
            .max(127)
            .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
          // Shown to the user only; never used as a path.
          fileName: z.string().min(1).max(CONTENT_LIMITS.FILE_NAME_MAX_LENGTH).optional(),
          width: dimension.optional(),
          height: dimension.optional(),
          durationMs: z
            .number()
            .int()
            .min(0)
            .max(24 * 60 * 60 * 1000)
            .optional(),
          blurHash: z
            .string()
            .regex(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{6,100}$/)
            .optional(),
          caption: text.optional(),
          voiceNote: z.boolean().optional(),
          // Voice notes: loudness bars, one base64url digit each (media/waveform.js).
          waveform: z.string().regex(WAVEFORM_PATTERN).optional(),
        }),
      ],
    ]),
  ],
  [
    CONTENT_TYPE.CALL_DTLS,
    new Map([
      [
        1,
        // A call's DTLS fingerprints, sent only as Signal ciphertext on the call's own signaling
        // (see calls/callSecurity.js); a valid one still proves nothing until it is bound to
        // the call and peer it is checked against.
        z.strictObject({
          type: z.literal(CONTENT_TYPE.CALL_DTLS),
          version: z.literal(1),
          callId: z.uuid(),
          role: z.enum(['caller', 'callee']),
          from: objectIdSchema,
          to: objectIdSchema,
          kind: z.enum(CALL_KINDS),
          fingerprints: z
            .array(fingerprint)
            .min(1)
            .max(CONTENT_LIMITS.FINGERPRINTS_MAX)
            .refine((list) => new Set(list).size === list.length, 'No duplicates'),
        }),
      ],
    ]),
  ],
]);

/** Every typed content has these; read first, to tell unknown from malformed. */
const header = z.object({
  type: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  version: z.number().int().min(1).max(0x7fffffff),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** A text chat message (current version). */
export const textContent = (value) => ({ type: CONTENT_TYPE.TEXT, version: 1, text: value });

/** An attachment message (current version); optional fields are left out when unknown. */
export function attachmentContent(fields) {
  const content = { type: CONTENT_TYPE.ATTACHMENT, version: 1 };
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') content[name] = value;
  }
  return content;
}

/**
 * Encodes content for encryption. Only content that passes its own schema and the size limit
 * is ever produced; anything else throws a ContentError (nothing is sent).
 *
 * @returns {Uint8Array}
 */
export function encodeContent(content) {
  const schema = SCHEMAS.get(content?.type)?.get(content?.version);
  const parsed = schema?.safeParse(content);
  if (!parsed?.success) throw new ContentError(CONTENT_ERROR.INVALID, 'Not valid message content');
  const json = encoder.encode(JSON.stringify(parsed.data));
  if (1 + json.length > CONTENT_LIMITS.MAX_BYTES) {
    throw new ContentError(CONTENT_ERROR.TOO_LARGE, 'Message is too large');
  }
  const bytes = new Uint8Array(1 + json.length);
  bytes[0] = CONTENT_MARKER;
  bytes.set(json, 1);
  return bytes;
}

const invalid = (detail, head = {}) => ({
  ok: false,
  reason: 'invalid',
  internal: head.type ? isInternalType(head.type) : false,
  ...head,
  detail,
});

/**
 * Decodes a decrypted Signal plaintext. Never throws.
 *
 * @param {Uint8Array} bytes
 * @returns {(
 *   | { ok: true, legacy: boolean, internal: boolean, content: object }
 *   | { ok: false, reason: 'unsupported' | 'invalid', internal: boolean,
 *       type?: string, version?: number, detail?: string }
 * )} `legacy`: raw text from an app version before R1. `internal`: control content, never a
 *   chat message (also set when such content is unsupported or malformed).
 */
export function decodeContent(bytes) {
  if (bytes.length === 0 || bytes[0] !== CONTENT_MARKER) {
    // Raw UTF-8 text, decoded exactly as before R1. Always text, whatever it looks like.
    return { ok: true, legacy: true, internal: false, content: textContent(decoder.decode(bytes)) };
  }
  if (bytes.length > CONTENT_LIMITS.MAX_BYTES) return invalid('too_large');

  const body = bytes.subarray(1);
  const json = decoder.decode(body);
  // Not valid UTF-8 if decoding had to replace anything (works without a `fatal` decoder).
  if (!sameBytes(encoder.encode(json), body)) return invalid('encoding');
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return invalid('json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('shape');

  const head = header.safeParse(value);
  if (!head.success) return invalid('header');
  const { type, version } = head.data;
  const internal = isInternalType(type);
  const schema = SCHEMAS.get(type)?.get(version);
  if (!schema) return { ok: false, reason: 'unsupported', internal, type, version };
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalid('fields', { type, version });
  return { ok: true, legacy: false, internal, content: parsed.data };
}
