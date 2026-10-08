import { describe, expect, it } from 'vitest';

import {
  base64ByteLength,
  ciphertextTypeSchema,
  ecPublicKeySchema,
  kyberPublicKeySchema,
  signatureSchema,
  clientMessageIdSchema,
  cursorSchema,
  devicePlatformSchema,
  emailSchema,
  messageIdBatchSchema,
  objectIdSchema,
  otpSchema,
  pageSizeSchema,
  pusherSocketIdSchema,
} from '../src/validation.js';

describe('shared validation', () => {
  it('accepts a valid ObjectId and rejects malformed ones', () => {
    expect(objectIdSchema.safeParse('507f1f77bcf86cd799439011').success).toBe(true);
    expect(objectIdSchema.safeParse('507f1f77bcf86cd79943901').success).toBe(false);
    expect(objectIdSchema.safeParse({ $gt: '' }).success).toBe(false);
  });

  it('requires a UUID v4 clientMessageId', () => {
    expect(clientMessageIdSchema.safeParse('3b241101-e2bb-4255-8caf-4136c566a962').success).toBe(
      true,
    );
    expect(clientMessageIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('accepts only 6-digit OTPs', () => {
    expect(otpSchema.safeParse('012345').success).toBe(true);
    expect(otpSchema.safeParse('12345').success).toBe(false);
    expect(otpSchema.safeParse('1234567').success).toBe(false);
    expect(otpSchema.safeParse('12a456').success).toBe(false);
    expect(otpSchema.safeParse(123456).success).toBe(false);
  });

  it('normalises valid emails and rejects malformed ones', () => {
    expect(emailSchema.parse('  Alice.Smith@Example.COM ')).toBe('alice.smith@example.com');
    for (const bad of ['', 'alice', 'alice@', '@example.com', 'a b@example.com', 'a@b\n.com']) {
      expect(emailSchema.safeParse(bad).success).toBe(false);
    }
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@x.io`).success).toBe(false);
    expect(emailSchema.safeParse({ $ne: null }).success).toBe(false);
  });

  it('accepts only known device platforms', () => {
    expect(devicePlatformSchema.safeParse('android').success).toBe(true);
    expect(devicePlatformSchema.safeParse('windows').success).toBe(false);
  });

  it('validates Signal public material by exact decoded size', () => {
    const b64 = (n) => btoa(String.fromCharCode(...new Uint8Array(n).fill(5)));
    expect(ecPublicKeySchema.safeParse(b64(33)).success).toBe(true);
    expect(ecPublicKeySchema.safeParse(b64(32)).success).toBe(false);
    expect(signatureSchema.safeParse(b64(64)).success).toBe(true);
    expect(kyberPublicKeySchema.safeParse(b64(1569)).success).toBe(true);
    expect(ecPublicKeySchema.safeParse('not base64!').success).toBe(false);
    expect(base64ByteLength(b64(10))).toBe(10);
  });

  it('accepts only known ciphertext types', () => {
    expect(ciphertextTypeSchema.safeParse(3).success).toBe(true);
    expect(ciphertextTypeSchema.safeParse(2).success).toBe(true);
    expect(ciphertextTypeSchema.safeParse(1).success).toBe(false);
  });

  it('coerces cursors and rejects negatives', () => {
    expect(cursorSchema.parse('42')).toBe(42);
    expect(cursorSchema.safeParse('-1').success).toBe(false);
  });

  it('validates message id batches (non-empty, bounded, unique ObjectIds)', () => {
    const id = '507f1f77bcf86cd799439011';
    expect(messageIdBatchSchema.safeParse([id]).success).toBe(true);
    expect(messageIdBatchSchema.safeParse([]).success).toBe(false);
    expect(messageIdBatchSchema.safeParse([id, id]).success).toBe(false);
    expect(messageIdBatchSchema.safeParse(['nope']).success).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(24, '0'));
    expect(messageIdBatchSchema.safeParse(many).success).toBe(false);
  });

  it('accepts only Pusher-shaped socket ids', () => {
    expect(pusherSocketIdSchema.safeParse('123456.7890123').success).toBe(true);
    for (const bad of ['', '123', '1.2.3', '1.2;x', 'abc.def', { $ne: 1 }]) {
      expect(pusherSocketIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('bounds page size and applies the default', () => {
    expect(pageSizeSchema.parse(undefined)).toBe(50);
    expect(pageSizeSchema.safeParse(1000).success).toBe(false);
  });
});
