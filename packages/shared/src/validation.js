import { z } from 'zod';

import { CIPHERTEXT_TYPE, DEVICE_PLATFORM, LIMITS, OTP_LENGTH, SIGNAL } from './constants.js';

/** 24-char hex MongoDB ObjectId. */
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

/**
 * Client-generated idempotency key for every message (architecture §4).
 * UUID v4 so devices can generate it offline without coordination.
 */
export const clientMessageIdSchema = z.uuid({ version: 'v4' });

/** Client-generated device identifier (UUID v4, created once per install). */
export const deviceIdSchema = z.uuid({ version: 'v4' });

/** Numeric one-time password exactly as typed by the user. */
export const otpSchema = z
  .string()
  .regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Must be ${OTP_LENGTH} digits`);

/**
 * Email address, trimmed and lower-cased so one mailbox always maps to one account.
 * 254 is the longest address SMTP can deliver to.
 */
export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .toLowerCase()
  .pipe(z.email({ error: 'Must be a valid email address' }));

export const devicePlatformSchema = z.enum(Object.values(DEVICE_PLATFORM));

/** Opaque sync cursor: the last server-assigned sequence number seen. */
export const cursorSchema = z.coerce.number().int().nonnegative();

// --- Signal Protocol public material (opaque bytes, standard base64). ---

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decoded byte length of a well-formed base64 string (no Buffer: also runs on Hermes). */
export function base64ByteLength(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Base64 string whose decoded size is exactly `bytes`, or between `min` and `max`. */
export function base64Bytes({ bytes, min = bytes, max = bytes }) {
  return z
    .string()
    .regex(BASE64, 'Must be base64')
    .refine(
      (value) => {
        const length = base64ByteLength(value);
        return length >= min && length <= max;
      },
      `Must decode to ${bytes ?? `${min}-${max}`} bytes`,
    );
}

export const keyIdSchema = z.number().int().min(1).max(SIGNAL.MAX_KEY_ID);
export const registrationIdSchema = z.number().int().min(1).max(SIGNAL.MAX_REGISTRATION_ID);
export const ecPublicKeySchema = base64Bytes({ bytes: SIGNAL.EC_PUBLIC_KEY_BYTES });
export const kyberPublicKeySchema = base64Bytes({ bytes: SIGNAL.KYBER_1024_PUBLIC_KEY_BYTES });
export const signatureSchema = base64Bytes({ bytes: SIGNAL.SIGNATURE_BYTES });

export const signedPreKeySchema = z.object({
  keyId: keyIdSchema,
  publicKey: ecPublicKeySchema,
  signature: signatureSchema,
});

export const kyberPreKeySchema = z.object({
  keyId: keyIdSchema,
  publicKey: kyberPublicKeySchema,
  signature: signatureSchema,
});

export const oneTimePreKeySchema = z.object({
  keyId: keyIdSchema,
  publicKey: ecPublicKeySchema,
});

export const ciphertextTypeSchema = z.union([
  z.literal(CIPHERTEXT_TYPE.WHISPER),
  z.literal(CIPHERTEXT_TYPE.PREKEY),
]);

export const ciphertextSchema = base64Bytes({ min: 1, max: SIGNAL.MAX_CIPHERTEXT_BYTES });

/** A batch of server message ids (read receipts, status lookups). */
export const messageIdBatchSchema = z
  .array(objectIdSchema)
  .min(1)
  .max(LIMITS.MESSAGE_BATCH_MAX)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate messageId');

/** Pusher connection id, e.g. "123456.7890123". */
export const pusherSocketIdSchema = z.string().regex(/^\d{1,20}\.\d{1,20}$/, 'Invalid socket id');

export const pageSizeSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(LIMITS.PAGE_SIZE_MAX)
  .default(LIMITS.PAGE_SIZE_DEFAULT);
