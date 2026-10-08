import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Small wrappers over Node's audited `crypto` primitives. No custom cryptography here:
 * only CSPRNG output, HMAC-SHA256, SHA-256 and constant-time comparison.
 */

/** Uniformly random numeric code from the CSPRNG (randomInt avoids modulo bias). */
export function generateNumericCode(length) {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, '0');
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hmacSha256(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
