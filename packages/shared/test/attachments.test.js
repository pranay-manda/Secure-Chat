import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT,
  ATTACHMENT_MAX_ENCRYPTED_BYTES,
  encryptedAttachmentSize,
  paddedAttachmentSize,
} from '../src/constants.js';
import { clientAttachmentIdSchema, encryptedAttachmentSizeSchema } from '../src/validation.js';

describe('attachment padding', () => {
  it('pads small files to the minimum bucket', () => {
    for (const size of [0, 1, 500, 1024]) expect(paddedAttachmentSize(size)).toBe(1024);
  });

  it('never shrinks, adds at most 6.25 %, and maps a whole bucket to one size', () => {
    for (let size = 1025; size < 5_000_000; size = Math.ceil(size * 1.013) + 7) {
      const padded = paddedAttachmentSize(size);
      expect(padded).toBeGreaterThanOrEqual(size);
      expect(padded - size).toBeLessThanOrEqual(size / 16);
      expect(paddedAttachmentSize(padded)).toBe(padded); // a bucket boundary is stable
    }
    // Two sizes in the same bucket are indistinguishable to the server.
    expect(paddedAttachmentSize(70_000)).toBe(paddedAttachmentSize(71_000));
  });

  it('computes exact integers up to the maximum (same on every platform)', () => {
    expect(paddedAttachmentSize(ATTACHMENT.MAX_BYTES)).toBe(ATTACHMENT.MAX_BYTES);
    expect(paddedAttachmentSize(1025)).toBe(1088);
    expect(paddedAttachmentSize(3_000_000)).toBe(3_014_656);
    expect(encryptedAttachmentSize(10)).toBe(1024 + 28);
    expect(ATTACHMENT_MAX_ENCRYPTED_BYTES).toBe(ATTACHMENT.MAX_BYTES + 28);
  });

  it('rejects sizes that are not non-negative integers', () => {
    for (const bad of [-1, 1.5, NaN, '10']) expect(() => paddedAttachmentSize(bad)).toThrow();
  });

  it('validates upload ids and encrypted sizes', () => {
    expect(clientAttachmentIdSchema.safeParse(randomUUID()).success).toBe(true);
    expect(clientAttachmentIdSchema.safeParse('abc').success).toBe(false);
    expect(encryptedAttachmentSizeSchema.safeParse(ATTACHMENT_MAX_ENCRYPTED_BYTES).success).toBe(
      true,
    );
    expect(
      encryptedAttachmentSizeSchema.safeParse(ATTACHMENT_MAX_ENCRYPTED_BYTES + 1).success,
    ).toBe(false);
    expect(encryptedAttachmentSizeSchema.safeParse(0).success).toBe(false);
  });
});
